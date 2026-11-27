import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig, sessionLabel } from "../lib/config.ts";
import { claimInbox, sendMessage } from "../lib/messaging.ts";
import { processStart } from "../lib/process.ts";
import { writeState } from "../lib/state.ts";
import { MAX_ATTEMPTS, REDELIVER_MS, TTL_MS, createDispatcher } from "../web/server/dispatch.ts";

const CODEX_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const OPENCODE_ID = "ses_0123456789abcdefghijABCDEFGH";

async function setup(t, { harness = "codex", event = "Stop", sessionId = harness === "codex" ? CODEX_ID : OPENCODE_ID } = {}) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "operator", AI_COLLAB_PEERS: "alice,bob,codex,opencode,cursor" });
  const cfg = loadConfig(env);
  const label = sessionLabel(sessionId);
  const address = `${harness}#${label}`;
  const registry = join(cfg.stateDir, cfg.project, "registry");
  mkdirSync(registry, { recursive: true });
  writeState(join(registry, `${address}.json`), {
    id: address, sessionId, cwd: "/tmp", harness, event, seenAt: Date.now(), pid: process.pid, pidStart: processStart(process.pid),
  });
  const bob = loadConfig(peerEnv(fake, { peer: "bob", AI_COLLAB_PEERS: env.AI_COLLAB_PEERS, AI_COLLAB_STATE_DIR: cfg.stateDir }));
  const target = loadConfig({ ...env, AI_COLLAB_PEER: harness }, { session: label });
  const clock = { t: Date.now() };
  const runs = [];
  const calls = [];
  const dispatcher = createDispatcher({
    projects: () => [cfg], now: () => clock.t, env: { HOME: cfg.stateDir },
    run: async (file, args) => { runs.push([file, args]); return 0; },
    opencode: async (method, path, options) => { calls.push([method, path, options.body]); return { ok: true, status: 200, body: {} }; },
    idle: async (session) => (session.event === "Stop" ? "idle" : "busy"),
  });
  return { fake, cfg, bob, target, address, clock, runs, calls, dispatcher, label, sessionId };
}

test("an idle Codex session gets a direct message through codex queue --resume and hooks skip it afterwards", async (t) => {
  const { bob, target, address, runs, dispatcher, sessionId } = await setup(t);
  await sendMessage(bob, address, "please review");
  const counts = await dispatcher.tick();
  assert.equal(counts.delivered, 1);
  assert.equal(runs.length, 1);
  assert.equal(runs[0][0], "codex");
  assert.deepEqual(runs[0][1].slice(0, 4), ["queue", "--thread", sessionId, "--message"]);
  assert.match(runs[0][1][4], /body="please review"/);
  assert.equal(runs[0][1].at(-1), "--resume");
  assert.deepEqual(await claimInbox(target), []);
  assert.equal((await dispatcher.tick()).delivered, 0);
  assert.equal(runs.length, 1);
});

test("a busy Codex session is left to its hooks", async (t) => {
  const { bob, target, address, runs, dispatcher } = await setup(t, { event: "PreToolUse" });
  await sendMessage(bob, address, "later");
  assert.equal((await dispatcher.tick()).delivered, 0);
  assert.equal(runs.length, 0);
  assert.equal((await claimInbox(target)).length, 1);
});

test("fyi messages and broadcasts are never pushed", async (t) => {
  const { bob, address, runs, dispatcher } = await setup(t);
  await sendMessage(bob, address, "low", { priority: "fyi" });
  await sendMessage(bob, "all", "to everyone");
  assert.equal((await dispatcher.tick()).delivered, 0);
  assert.equal(runs.length, 0);
});

test("a Cursor session is never pushed", async (t) => {
  const { bob, address, runs, calls, dispatcher } = await setup(t, { harness: "cursor", sessionId: CODEX_ID });
  await sendMessage(bob, address, "hello cursor");
  assert.equal((await dispatcher.tick()).delivered, 0);
  assert.deepEqual([runs.length, calls.filter(([method]) => method === "POST").length], [0, 0]);
});

test("an OpenCode session gets a queued prompt, or a steering one when urgent, with resume", async (t) => {
  const { bob, address, calls, dispatcher, sessionId } = await setup(t, { harness: "opencode" });
  await sendMessage(bob, address, "queue this");
  await dispatcher.tick();
  const prompt = calls.find(([method]) => method === "POST");
  assert.equal(prompt[1], `/api/session/${sessionId}/prompt`);
  assert.equal(prompt[2].delivery, "queue");
  assert.equal(prompt[2].resume, true);
  assert.match(prompt[2].text, /queue this/);
  await sendMessage(bob, address, "now!", { urgent: true });
  await dispatcher.tick();
  assert.equal(calls.filter(([method]) => method === "POST").at(-1)[2].delivery, "steer");
});

test("an expect_reply message is redelivered after 10 min as 'attempt N of 5' until answered", async (t) => {
  const { fake, bob, address, clock, runs, dispatcher, label } = await setup(t);
  const sent = await sendMessage(bob, address, "need an answer", { expectReply: true });
  await dispatcher.tick();
  assert.equal(runs.length, 1);
  assert.doesNotMatch(runs[0][1][4], /attempt/);
  assert.match(runs[0][1][4], /The sender is waiting for your reply/);
  clock.t += REDELIVER_MS - 1000;
  await dispatcher.tick();
  assert.equal(runs.length, 1, "not yet due");
  clock.t += 2000;
  assert.equal((await dispatcher.tick()).redelivered, 1);
  assert.match(runs[1][1][4], /attempt 2 of 5/);

  // The target answers: no further redelivery.
  const targetCfg = loadConfig(peerEnv(fake, { peer: "codex", AI_COLLAB_PEERS: "alice,bob,codex", AI_COLLAB_STATE_DIR: bob.stateDir }), { session: label });
  await sendMessage(targetCfg, "bob", "on it", { replyTo: sent.id, state: "working" });
  clock.t += REDELIVER_MS + 1000;
  const counts = await dispatcher.tick();
  assert.deepEqual([counts.redelivered, counts.dropped], [0, 1]);
  assert.equal(runs.length, 2);
});

test("redelivery stops after 5 attempts and after the 24 h TTL", async (t) => {
  const { bob, address, clock, runs, dispatcher } = await setup(t);
  await sendMessage(bob, address, "never answered", { expectReply: true });
  await dispatcher.tick();
  for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
    clock.t += REDELIVER_MS + 1000;
    assert.equal((await dispatcher.tick()).redelivered, 1);
  }
  assert.equal(runs.length, MAX_ATTEMPTS);
  assert.match(runs.at(-1)[1][4], /attempt 5 of 5/);
  clock.t += REDELIVER_MS + 1000;
  const counts = await dispatcher.tick();
  assert.deepEqual([counts.redelivered, counts.dropped], [0, 1]);
  assert.equal(runs.length, MAX_ATTEMPTS);

  await sendMessage(bob, address, "too old", { expectReply: true });
  await dispatcher.tick();
  const before = runs.length;
  clock.t += TTL_MS + 1000;
  assert.equal((await dispatcher.tick()).dropped, 1);
  assert.equal(runs.length, before);
});

test("a failed push leaves the message for the session's hooks", async (t) => {
  const { fake, bob, target, address } = await setup(t);
  const failing = createDispatcher({
    projects: () => [loadConfig(peerEnv(fake, { peer: "operator", AI_COLLAB_PEERS: "alice,bob,codex", AI_COLLAB_STATE_DIR: bob.stateDir }))],
    run: async () => 1, idle: async () => "idle", env: {},
  });
  await sendMessage(bob, address, "keep me");
  assert.equal((await failing.tick()).delivered, 0);
  assert.equal((await claimInbox(target)).length, 1);
});
