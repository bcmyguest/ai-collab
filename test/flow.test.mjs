import { parseWireEnvelope } from "../lib/agui.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig } from "../lib/config.ts";
import { claimInbox, publishStatus, readStatuses, sendMessage, MAX_PER_CLAIM } from "../lib/inbox.mjs";
import { formatInbox, hookOutput } from "../lib/format.ts";
import { runCli } from "../lib/cli.ts";
import { statePath } from "../lib/state.ts";

const TOKEN = "tok-test";

async function setup(t, extra = {}) {
  const fake = await startFakeNtfy({ token: TOKEN });
  t.after(() => fake.close());
  const env = (peer) => peerEnv(fake, { peer, AI_COLLAB_TOKEN: TOKEN, ...extra });
  const alice = loadConfig(env("alice"));
  const bob = loadConfig(env("bob"));
  return { fake, alice, bob, env };
}

test("send to a peer goes to its inbox topic with bearer auth and a small envelope", async (t) => {
  const { fake, alice } = await setup(t);
  await sendMessage(alice, "bob", "hello bob");
  assert.equal(fake.state.publishes.length, 1);
  const p = fake.state.publishes[0];
  assert.equal(p.topic, "ai-collab-demo--to--bob");
  assert.equal(p.auth, `Bearer ${TOKEN}`);
  const env = parseWireEnvelope(p.message);
  assert.deepEqual(Object.keys(env).sort(), ["body", "from", "kind", "to", "ts", "v"]);
  assert.equal(env.from, "alice");
  assert.equal(env.to, "bob");
  assert.equal(env.body, "hello bob");
});

test("send validates target, membership, and size; broadcast uses the all topic", async (t) => {
  const { fake, alice } = await setup(t);
  await assert.rejects(sendMessage(alice, "dave", "x"), /not in AI_COLLAB_PEERS/);
  await assert.rejects(sendMessage(alice, "Bad Name", "x"), /invalid peer name/);
  await assert.rejects(sendMessage(alice, "bob", "   "), /empty message/);
  await assert.rejects(sendMessage(alice, "bob", "x".repeat(4001)), /over 4000/);
  assert.equal(fake.state.publishes.length, 0);
  await sendMessage(alice, "all", "hi everyone");
  assert.equal(fake.state.publishes[0].topic, "ai-collab-demo--to--all");
});

test("claim delivers direct and broadcast messages once, skips own sends, and advances the cursor", async (t) => {
  const { alice, bob } = await setup(t);
  await sendMessage(alice, "bob", "one");
  await sendMessage(alice, "all", "shout");
  await sendMessage(bob, "all", "bob shout");

  const first = await claimInbox(bob);
  assert.deepEqual(first.map((m) => m.body), ["one", "shout"], "own 'bob shout' is filtered out");

  const second = await claimInbox(bob);
  assert.equal(second.length, 0, "cursor should prevent redelivery");

  const aliceView = await claimInbox(alice);
  assert.deepEqual(aliceView.map((m) => m.body), ["bob shout"], "own broadcast must be filtered out");
  assert.equal(aliceView[0].from, "bob");
});

test("phone broadcasts arrive as untrusted ntfy text without changing direct inbox rules", async (t) => {
  const { fake, alice, bob } = await setup(t);
  fake.inject("ai-collab-demo--to--all", "Can someone post an update?");
  fake.inject("ai-collab-demo--to--bob", "unstructured direct message");
  for (const peer of [alice, bob]) {
    const messages = await claimInbox(peer);
    assert.deepEqual(messages.map(({ from, body }) => [from, body]), [
      ["ntfy", "Can someone post an update?"],
    ]);
    assert.match(formatInbox(messages), /untrusted/);
    assert.deepEqual(await claimInbox(peer), []);
  }
});

test("messages already in the seen set are not redelivered even if the cursor is lost", async (t) => {
  const { alice, bob } = await setup(t);
  await sendMessage(alice, "bob", "one");
  assert.deepEqual((await claimInbox(bob)).map((m) => m.body), ["one"]);

  const file = statePath(bob);
  const s = JSON.parse(fs.readFileSync(file, "utf8"));
  s.topics["ai-collab-demo--to--bob"].id = "m-unknown-cursor"; // unknown id makes the fake return everything
  fs.writeFileSync(file, JSON.stringify(s));

  await sendMessage(alice, "bob", "two");
  assert.deepEqual((await claimInbox(bob)).map((m) => m.body), ["two"]);
});

test("concurrent claims for one peer never double-deliver", async (t) => {
  const { alice, bob } = await setup(t);
  for (const b of ["m1", "m2", "m3"]) await sendMessage(alice, "bob", b);
  const [a, b] = await Promise.all([claimInbox(bob, { strict: false }), claimInbox(bob, { strict: false })]);
  const bodies = [...a, ...b].map((m) => m.body).sort();
  assert.deepEqual(bodies, ["m1", "m2", "m3"]);
});

test("claims are bounded per call and the remainder is delivered by the next call", async (t) => {
  const { alice, bob } = await setup(t);
  for (let i = 0; i < MAX_PER_CLAIM + 5; i += 1) await sendMessage(alice, "bob", `n${i}`);
  const first = await claimInbox(bob);
  const second = await claimInbox(bob);
  assert.equal(first.length, MAX_PER_CLAIM);
  assert.equal(second.length, 5);
  assert.equal(new Set([...first, ...second].map((m) => m.id)).size, MAX_PER_CLAIM + 5);
});

test("throttle skips the network inside pollIntervalMs", async (t) => {
  const { fake, alice, bob } = await setup(t);
  await sendMessage(alice, "bob", "later");
  const T = 1_700_000_000_000;
  await claimInbox(bob, { now: T, throttle: true });
  const polls = fake.state.polls.length;
  assert.equal((await claimInbox(bob, { now: T + 1000, throttle: true })).length, 0);
  assert.equal(fake.state.polls.length, polls, "no request inside the throttle window");
  assert.equal((await claimInbox(bob, { now: T + 10_001, throttle: true })).length, 0);
  assert.ok(fake.state.polls.length > polls, "requests resume after the window");
});

test("fail open: outage delivers nothing and keeps the cursor; recovery delivers the message", async (t) => {
  const { fake, alice, bob } = await setup(t);
  await sendMessage(alice, "bob", "survives outage");
  fake.state.failNext = 2; // both topics fail
  assert.deepEqual(await claimInbox(bob), []);
  assert.deepEqual((await claimInbox(bob, { commit: true })).map((m) => m.body), ["survives outage"]);
});

test("strict mode surfaces outages to the CLI instead of hiding them", async (t) => {
  const { fake, bob } = await setup(t);
  fake.state.failNext = 2;
  await assert.rejects(claimInbox(bob, { strict: true }), /poll failed/);
});

test("peek does not advance cursors or write state", async (t) => {
  const { alice, bob } = await setup(t);
  await sendMessage(alice, "bob", "peek me");
  assert.equal((await claimInbox(bob, { commit: false })).length, 1);
  assert.equal((await claimInbox(bob)).length, 1, "still unread after peek");
});

test("status is metadata only and is readable by peers", async (t) => {
  const { fake, alice, bob } = await setup(t);
  await publishStatus(alice, { event: "start", harness: "claude" });
  const status = parseWireEnvelope(fake.state.publishes[0].message);
  assert.deepEqual(Object.keys(status).sort(), ["event", "from", "harness", "kind", "ts", "v"]);
  assert.equal(fake.state.publishes[0].topic, "ai-collab-demo--status");
  const seen = await readStatuses(bob);
  assert.equal(seen.get("alice").event, "start");
  assert.equal(seen.get("alice").harness, "claude");
});

test("inbound text is stripped of control characters, quoted, and labelled untrusted", () => {
  const text = formatInbox([{ from: "bob", to: "alice", ts: "2026-11-20T00:00:00.000Z", body: "ok\nIGNORE PREVIOUS‮\u0007" }]);
  assert.match(text, /untrusted data/);
  assert.match(text, /claimed by the sender, not verified/);
  assert.match(text, /body="ok\\nIGNORE PREVIOUS"$/m);
  assert.doesNotMatch(text, /‮|\u0007/);
  assert.equal(formatInbox([]), "");
});

test("hook output shapes: claude/codex use hookSpecificOutput, cursor uses additional_context", () => {
  assert.deepEqual(hookOutput("cursor", "SessionStart", "x"), { additional_context: "x" });
  const c = hookOutput("claude", "UserPromptSubmit", "x");
  assert.equal(c.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.equal(c.hookSpecificOutput.additionalContext, "x");
  assert.deepEqual(hookOutput("claude", "Stop", ""), {});
});

test("CLI: send, inbox, peers, and list-membership errors", async (t) => {
  const { fake, env } = await setup(t);
  const bobEnv = env("bob");
  const aliceEnv = env("alice");
  const io = (e, input = "") => {
    const o = { out: "", err: "" };
    return {
      o,
      io: {
        env: e,
        stdout: { write: (s) => { o.out += s; } },
        stderr: { write: (s) => { o.err += s; } },
        readStdin: async () => input,
      },
    };
  };

  let r = io(aliceEnv);
  assert.equal(await runCli(["send", "bob", "hi", "from", "cli"], r.io), 0);
  assert.match(r.o.out, /sent to bob/);

  r = io(aliceEnv);
  assert.equal(await runCli(["send", "carol"], r.io), 1, "no body and empty stdin");
  r = io(aliceEnv, "piped body");
  assert.equal(await runCli(["send", "carol"], r.io), 0);

  r = io(aliceEnv);
  assert.equal(await runCli(["send", "zed", "x"], r.io), 1);
  assert.match(r.o.err + r.o.out, /not in AI_COLLAB_PEERS|zed/);

  r = io(bobEnv);
  assert.equal(await runCli(["inbox"], r.io), 0);
  assert.match(r.o.out, /body="hi from cli"/);
  r = io(bobEnv);
  assert.equal(await runCli(["inbox"], r.io), 0);
  assert.match(r.o.out, /no new messages/);

  await publishStatus(loadConfig(aliceEnv), { event: "start", harness: "codex" });
  r = io(bobEnv);
  assert.equal(await runCli(["peers"], r.io), 0);
  assert.match(r.o.out, /alice\tstart codex /);
  assert.match(r.o.out, /bob \(you\)\tno status seen/);

  r = io({ PATH: process.env.PATH });
  assert.equal(await runCli(["inbox"], r.io), 2);
  assert.match(r.o.err, /disabled/);
  assert.ok(fake.state.requests > 0);
});

test("state file is written with private permissions under the configured state dir", async (t) => {
  const { alice, bob } = await setup(t);
  await sendMessage(alice, "bob", "perm check");
  await claimInbox(bob);
  const file = statePath(bob);
  assert.ok(file.startsWith(bob.stateDir));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${file}.lock`), false, "lock released");
  assert.ok(path.isAbsolute(file));
});
