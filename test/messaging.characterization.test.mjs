import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig, sessionLabel } from "../lib/config.ts";
import { sendMessage } from "../lib/messaging.ts";
import { parseWireEnvelope } from "../lib/agui.ts";
import { awaitReply, waitForIdle, waitForMessages, waitForReply } from "../lib/agents.ts";
import { readInbox } from "../lib/messaging.ts";
import { runWaiter } from "../lib/waiter.ts";
import { runCli } from "../lib/cli.ts";
import { decideStop } from "../lib/stop.ts";
import { requestWait } from "../lib/questions.ts";
import { claimInbox } from "../lib/messaging.ts";
import { settleReceipts } from "../lib/receipts.ts";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const LABEL = sessionLabel(SESSION_ID);
const RECEIPTS = "ai-collab-demo--receipts";
const CODEX = "codex#0123456789abcdef";

// Stands in for the stream waiter: a short pause, then the loop polls again.
const pause = async () => { await delay(20); return "event"; };

async function setup(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "alice", AI_COLLAB_PEERS: "alice,bob" });
  const alice = loadConfig(env);
  const bob = loadConfig(peerEnv(fake, { peer: "bob", AI_COLLAB_PEERS: env.AI_COLLAB_PEERS, AI_COLLAB_STATE_DIR: alice.stateDir }));
  return { fake, env, alice, bob };
}

function receiptIds(fake) {
  return fake.state.publishes
    .filter((p) => p.topic === RECEIPTS)
    .flatMap((p) => parseWireEnvelope(p.message)?.ids ?? []);
}

test("waitForMessages rejects with AbortError when the signal aborts mid-wait", { timeout: 10000 }, async (t) => {
  const { bob } = await setup(t);
  bob.stopPollMs = 50;
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(waitForMessages(bob, { seconds: 5, signal: ac.signal }), { name: "AbortError" });
});

test("waitForMessages times out with no messages at its deadline", { timeout: 10000 }, async (t) => {
  const { bob } = await setup(t);
  const wait = async () => { await delay(10); return "timeout"; };
  assert.deepEqual(await waitForMessages(bob, { seconds: 1, wait }), { status: "timeout", messages: [] });
});

test("awaitReply returns pending with its note at the deadline and rejects when pre-aborted", { timeout: 10000 }, async (t) => {
  const { alice } = await setup(t);
  assert.deepEqual(await awaitReply(alice, "m1234", { awaitSeconds: 1, wait: pause }), {
    status: "pending", note: "No reply yet; call wait to keep listening.",
  });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(awaitReply(alice, "m1234", { awaitSeconds: 5, signal: ac.signal }), { name: "AbortError" });
});

test("waitForIdle rejects with AbortError when aborted during its poll sleep", { timeout: 10000 }, async (t) => {
  const { alice } = await setup(t);
  const list = () => [{ id: CODEX, runningJobs: 0, online: true }];
  const idle = async () => "busy";
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(waitForIdle(alice, CODEX, { seconds: 5, idle, list, signal: ac.signal }), { name: "AbortError" });
});

test("waitForReply returns pending at the deadline, retries after an error step, and rejects when pre-aborted", { timeout: 10000 }, async (t) => {
  const { alice } = await setup(t);
  assert.deepEqual(await waitForReply(alice, "m1234", { awaitSeconds: 0, wait: pause }), { status: "pending" });
  let errors = 0;
  const failing = async () => { errors += 1; return "error"; };
  assert.deepEqual(await waitForReply(alice, "m1234", { awaitSeconds: 1, wait: failing }), { status: "pending" });
  assert.ok(errors >= 1);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(waitForReply(alice, "m1234", { awaitSeconds: 5, wait: pause, signal: ac.signal }), { name: "AbortError" });
});

test("runWaiter returns code 0 when aborted with no waiting message", async (t) => {
  const { env } = await setup(t);
  const cfg = loadConfig(env, { session: LABEL });
  const ac = new AbortController();
  ac.abort();
  assert.deepEqual(await runWaiter(cfg, { maxMs: 5000, signal: ac.signal }), { code: 0 });
});

test("runWaiter claims a waiting message before it checks the abort, so an aborted waiter still wakes", async (t) => {
  const { env, bob } = await setup(t);
  const cfg = loadConfig(env, { session: LABEL });
  await sendMessage(bob, `alice#${LABEL}`, "still waiting");
  const ac = new AbortController();
  ac.abort();
  const r = await runWaiter(cfg, { maxMs: 5000, signal: ac.signal });
  assert.equal(r.code, 2);
  assert.match(r.text, /body="still waiting"/);
  assert.equal((await readInbox(cfg, { peek: true, strict: false })).length, 0);
});

test("runWaiter publishes read receipts for the messages it wakes on", async (t) => {
  const { fake, env, bob } = await setup(t);
  const cfg = loadConfig(env, { session: LABEL });
  const sent = await sendMessage(bob, `alice#${LABEL}`, "review PR 12");
  const r = await runWaiter(cfg, { maxMs: 5000 });
  assert.equal(r.code, 2);
  assert.ok(receiptIds(fake).includes(sent.id));
});

test("readInbox peek leaves messages unread and publishes no receipts; a claim publishes them", async (t) => {
  const { fake, alice, bob } = await setup(t);
  const sent = await sendMessage(bob, "alice", "one");
  assert.deepEqual((await readInbox(alice, { peek: true })).map((m) => m.body), ["one"]);
  assert.deepEqual(receiptIds(fake), []);
  assert.deepEqual((await readInbox(alice)).map((m) => m.body), ["one"]);
  assert.deepEqual(receiptIds(fake), [sent.id]);
  assert.deepEqual(await readInbox(alice), []);
});

test("the CLI inbox --peek prints the message and leaves it unread for the next inbox", async (t) => {
  const { fake, env, bob } = await setup(t);
  await sendMessage(bob, "alice", "peek me");
  const run = async (argv) => {
    const out = [];
    const code = await runCli(argv, { env, stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} } });
    return { code, out: out.join("") };
  };
  const peeked = await run(["inbox", "--peek"]);
  assert.equal(peeked.code, 0);
  assert.match(peeked.out, /body="peek me"/);
  assert.deepEqual(receiptIds(fake), [], "CLI peek publishes no receipt");
  const claimed = await run(["inbox"]);
  assert.match(claimed.out, /body="peek me"/);
  assert.equal((await run(["inbox"])).out, "no new messages\n");
});

test("stop: a message that arrives as the AFK wait times out is delivered with one receipt", { timeout: 10000 }, async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const session = "aabbccddeeff0123";
  const env = peerEnv(fake, { peer: "alice", AI_COLLAB_SESSION: session, AI_COLLAB_STOP_POLL_MS: "5000", AI_COLLAB_AFK_WAIT_S: "120" });
  const cfg = loadConfig(env);
  const operator = loadConfig(peerEnv(fake, { peer: "operator" }));
  fake.inject("ai-collab-demo--to--all", JSON.stringify({ v: 1, kind: "mode", from: "operator", mode: "on", ts: Date.now() }));
  await claimInbox(cfg);
  await requestWait(cfg);
  const wait = async () => {
    await sendMessage(operator, `alice#${session}`, "late");
    return "timeout";
  };
  const r = await decideStop(cfg, { host: "claude", input: { stop_hook_active: false }, wait });
  assert.equal(r.why, "messages");
  assert.match(r.text, /body="late"/);
  await settleReceipts();
  assert.equal(receiptIds(fake).length, 1);
});
