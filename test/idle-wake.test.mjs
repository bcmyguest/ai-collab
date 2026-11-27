// A Stop hook hold and the rewake waiter share one inbox: the hold delivers, the waiter yields; the hold status clears on work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { claimInbox, readStatuses, sendMessage } from "../lib/messaging.ts";
import { decideStop, noteHeld } from "../lib/stop.mjs";
import { requestWait } from "../lib/questions.mjs";
import { runWaiter } from "../lib/waiter.ts";

const HOOK = fileURLToPath(new URL("../scripts/ai-collab-hook.mjs", import.meta.url));
const SESSION_ID = "99999999-2222-3333-4444-555555555555";
const LABEL = sessionLabel(SESSION_ID);
const ALL = "ai-collab-demo--to--all";

async function setup(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "claude", AI_COLLAB_PEERS: "claude,bob", AI_COLLAB_ACTIVITY: "off", AI_COLLAB_AFK_WAIT_S: "8" });
  const cfg = loadConfig(env, { session: LABEL });
  const operator = loadConfig(peerEnv(fake, { peer: "operator", AI_COLLAB_PEERS: "claude,bob", AI_COLLAB_STATE_DIR: env.AI_COLLAB_STATE_DIR }));
  fake.inject(ALL, JSON.stringify({ v: 1, kind: "mode", from: "operator", mode: "on", ts: Date.now() }));
  await claimInbox(cfg);
  return { env, cfg, operator };
}

function runHook(env, args, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out: out.trim() }));
    child.stdin.end(JSON.stringify(input));
  });
}

async function lastStatus(cfg) {
  return (await readStatuses(cfg)).get(`claude#${LABEL}`)?.event;
}

test("an untagged message in the session's own chat during a Stop hold reaches the Stop hook, not the rewake waiter", { timeout: 20000 }, async (t) => {
  const { cfg, operator } = await setup(t);
  await requestWait(cfg);
  // The Stop hook's wake-up comes later than the waiter's, as it did in the live session.
  const slowWait = async (ms) => { await delay(Math.min(ms, 1500)); return "event"; };
  const stopping = decideStop(cfg, { host: "claude", input: { stop_hook_active: false }, wait: slowWait, sliceMaxS: 4, queued: null });
  const waiting = runWaiter(cfg, { maxMs: 5000 });
  await delay(300);
  await sendMessage(operator, `claude#${LABEL}`, "check the deploy", { operatorThread: true });
  const [stop, wake] = await Promise.all([stopping, waiting]);
  assert.equal(stop.why, "messages", "the hold delivers the message itself");
  assert.match(stop.text, /check the deploy/);
  assert.equal(wake.code, 0, "the waiter left the message to the Stop hook");
});

test("the rewake waiter wakes the session once the Stop hook has ended", { timeout: 20000 }, async (t) => {
  const { cfg, operator } = await setup(t);
  assert.deepEqual(await decideStop(cfg, { host: "claude", input: { stop_hook_active: false }, queued: null }), { action: "stop" });
  const waiting = runWaiter(cfg, { maxMs: 6000 });
  setTimeout(() => sendMessage(operator, `claude#${LABEL}`, "idle ping", { operatorThread: true }), 300);
  const wake = await waiting;
  assert.equal(wake.code, 2);
  assert.match(wake.text, /idle ping/);
});

test("the hold status gives way to start when the held Stop hook continues with a message", { timeout: 30000 }, async (t) => {
  const { env, cfg, operator } = await setup(t);
  await requestWait(cfg);
  const hook = runHook(env, ["--host", "claude"], { hook_event_name: "Stop", session_id: SESSION_ID, cwd: "/tmp", stop_hook_active: false });
  for (let i = 0; i < 50 && await lastStatus(cfg) !== "hold"; i++) await delay(100);
  assert.equal(await lastStatus(cfg), "hold");
  await sendMessage(operator, `claude#${LABEL}`, "go on", { operatorThread: true });
  const r = await hook;
  assert.match(r.out, /go on/);
  assert.equal(await lastStatus(cfg), "start");
});

test("the hold status gives way to start on the session's next tool call", { timeout: 20000 }, async (t) => {
  const { env, cfg } = await setup(t);
  noteHeld(cfg);
  const { publishStatus } = await import("../lib/messaging.ts");
  await publishStatus(cfg, { event: "hold", harness: "claude" });
  await runHook(env, ["--activity", "--host", "claude"], { hook_event_name: "PreToolUse", session_id: SESSION_ID, cwd: "/tmp", tool_name: "Bash", tool_input: { command: "ls" } });
  assert.equal(await lastStatus(cfg), "start");
  // A subagent's tool call leaves the parent's status alone.
  noteHeld(cfg);
  await publishStatus(cfg, { event: "hold", harness: "claude" });
  await runHook(env, ["--activity", "--host", "claude"], { hook_event_name: "PreToolUse", session_id: SESSION_ID, cwd: "/tmp", agent_id: "a1", tool_name: "Bash", tool_input: {} });
  assert.equal(await lastStatus(cfg), "hold");
});
