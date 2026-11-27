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
import { decideStop, noteHeld, stopHookRunning } from "../lib/stop.mjs";
import { requestWait } from "../lib/questions.mjs";
import { runWaiter } from "../lib/waiter.ts";
import { processStart } from "../lib/process.mjs";
import { statePath, writeState } from "../lib/state.mjs";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

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
  return { env, cfg, operator, fake };
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

// Starts the rewake hook; exited is null until it ends, then {code, err}.
function startRewake(t, env, input) {
  const child = spawn(process.execPath, [HOOK, "--rewake", "--host", "claude"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  const w = { exited: null };
  child.stderr.on("data", (d) => { err += d; });
  w.done = new Promise((resolve) => child.on("close", (code) => { w.exited = { code, err }; resolve(w.exited); }));
  w.kill = () => { child.kill(); return w.done; };
  t.after(() => child.kill());
  child.stdin.end(JSON.stringify(input));
  return w;
}

function readJsonFile(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

function handoffFile(cfg) {
  return statePath(cfg).replace(/\.json$/, ".handoff.json");
}

// The marker a running Stop hook writes for its own pid (lib/stop.mjs).
function markerFile(cfg, pid) {
  return statePath(cfg).replace(/\.json$/, `.stop-running.${pid}.json`);
}

function writeMarker(cfg, pid, start = processStart(pid) || "") {
  const file = markerFile(cfg, pid);
  writeState(file, { pid, start });
  return file;
}

// A live process to stand in for a second Stop hook; stop() kills it.
function liveProcess(t) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => child.kill());
  return { pid: child.pid, stop: () => new Promise((resolve) => { child.once("exit", resolve); child.kill(); }) };
}

async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid;
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

test("the Stop hook keeps its marker after the hold decides, until the process exits", { timeout: 30000 }, async (t) => {
  const { env, cfg, operator, fake } = await setup(t);
  await requestWait(cfg);
  // The hook awaits its start publish after decideStop returns, so the marker is sampled while that request is open.
  let markedAtStart = null;
  const push = fake.state.publishes.push.bind(fake.state.publishes);
  fake.state.publishes.push = (rec) => {
    if (markedAtStart === null && /event\\?"\s*:\s*\\?"start/.test(JSON.stringify(rec))) markedAtStart = stopHookRunning(cfg);
    return push(rec);
  };
  const hook = runHook(env, ["--host", "claude"], { hook_event_name: "Stop", session_id: SESSION_ID, cwd: "/tmp", stop_hook_active: false });
  for (let i = 0; i < 50 && await lastStatus(cfg) !== "hold"; i++) await delay(100);
  await sendMessage(operator, `claude#${LABEL}`, "carry on", { operatorThread: true });
  const r = await hook;
  assert.match(r.out, /carry on/);
  assert.equal(markedAtStart, true, "the marker outlives decideStop");
  assert.equal(stopHookRunning(cfg), false, "the marker is gone once the hook exits");
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

test("the hold status stays while the session waits on the ai-collab wait tools", { timeout: 30000 }, async (t) => {
  const { env, cfg } = await setup(t);
  const { publishStatus } = await import("../lib/messaging.ts");
  noteHeld(cfg);
  await publishStatus(cfg, { event: "hold", harness: "claude" });
  for (const tool of ["mcp__plugin_ai-collab_ai-collab__wait_for_answer", "mcp__ai-collab__wait_for_operator"]) {
    for (const event of ["PreToolUse", "PostToolUse"]) {
      await runHook(env, ["--activity", "--host", "claude"], { hook_event_name: event, session_id: SESSION_ID, cwd: "/tmp", tool_name: tool, tool_input: { id: "q1" } });
      assert.equal(await lastStatus(cfg), "hold", `${event} ${tool}`);
    }
  }
  await runHook(env, ["--activity", "--host", "claude"], { hook_event_name: "PreToolUse", session_id: SESSION_ID, cwd: "/tmp", tool_name: "Bash", tool_input: { command: "ls" } });
  assert.equal(await lastStatus(cfg), "start");
});

test("a Cursor prompt after a hold publishes start", { timeout: 20000 }, async (t) => {
  const { env, cfg } = await setup(t);
  const { publishStatus } = await import("../lib/messaging.ts");
  noteHeld(cfg);
  await publishStatus(cfg, { event: "hold", harness: "cursor" });
  await runHook(env, ["--activity", "--host", "cursor"], { hook_event_name: "beforeSubmitPrompt", conversation_id: SESSION_ID, workspace_roots: ["/tmp"], prompt: "next step" });
  assert.equal(await lastStatus(cfg), "start");
});

test("the waiter yields while any of two Stop hooks runs, and wakes once both have ended", { timeout: 20000 }, async (t) => {
  const { cfg, operator } = await setup(t);
  const other = liveProcess(t);
  await delay(100);
  const own = writeMarker(cfg, process.pid);
  writeMarker(cfg, other.pid);
  await sendMessage(operator, `claude#${LABEL}`, "two hooks", { operatorThread: true });
  let woke = null;
  const waiting = runWaiter(cfg, { maxMs: 8000 }).then((r) => { woke = r; return r; });
  await delay(800);
  rmSync(own, { force: true });
  await delay(1200);
  assert.equal(woke, null, "the second Stop hook still runs, so the waiter claims nothing");
  await other.stop();
  const r = await waiting;
  assert.equal(r.code, 2);
  assert.match(r.text, /two hooks/);
});

test("a marker left by a dead Stop hook does not hold the waiter", { timeout: 15000 }, async (t) => {
  const { cfg, operator } = await setup(t);
  writeMarker(cfg, await deadPid(), "12345");
  await sendMessage(operator, `claude#${LABEL}`, "dead hook", { operatorThread: true });
  const r = await runWaiter(cfg, { maxMs: 3000 });
  assert.equal(r.code, 2);
  assert.match(r.text, /dead hook/);
});

test("a marker whose pid now belongs to another process (wrong start tick) does not hold the waiter", { timeout: 15000 }, async (t) => {
  const { cfg, operator } = await setup(t);
  writeMarker(cfg, process.pid, "1");
  await sendMessage(operator, `claude#${LABEL}`, "reused pid", { operatorThread: true });
  const r = await runWaiter(cfg, { maxMs: 3000 });
  assert.equal(r.code, 2);
  assert.match(r.text, /reused pid/);
});

test("a message that lands as the Stop hook starts reaches the hold, not the waiter armed at the prompt", { timeout: 40000 }, async (t) => {
  const { env, cfg, operator } = await setup(t);
  await requestWait(cfg);
  const waiter = startRewake(t, { ...env, AI_COLLAB_WAITER_MAX_S: "30" }, { hook_event_name: "UserPromptSubmit", session_id: SESSION_ID, cwd: "/tmp" });
  // The waiter streams the inbox by now.
  await delay(1500);
  const hook = runHook(env, ["--host", "claude"], { hook_event_name: "Stop", session_id: SESSION_ID, cwd: "/tmp", stop_hook_active: false });
  await sendMessage(operator, `claude#${LABEL}`, "landed at stop", { operatorThread: true });
  const r = await hook;
  assert.match(r.out, /landed at stop/, "the hold delivers the message");
  assert.equal(waiter.exited, null, "the waiter did not wake the session with it");
  const end = await waiter.kill();
  assert.doesNotMatch(end.err, /landed at stop/);
});

for (const offset of [0, 100, 200]) {
  test(`a message ${offset} ms after Stop reaches the hold while the waiter started at Stop replaces the prompt's waiter`, { timeout: 40000 }, async (t) => {
    const { env, cfg, operator } = await setup(t);
    await requestWait(cfg);
    const waiterEnv = { ...env, AI_COLLAB_WAITER_MAX_S: "30" };
    const old = startRewake(t, waiterEnv, { hook_event_name: "UserPromptSubmit", session_id: SESSION_ID, cwd: "/tmp" });
    await delay(1500);
    const hook = runHook(env, ["--host", "claude"], { hook_event_name: "Stop", session_id: SESSION_ID, cwd: "/tmp", stop_hook_active: false });
    const fresh = startRewake(t, waiterEnv, { hook_event_name: "Stop", session_id: SESSION_ID, cwd: "/tmp" });
    await delay(offset);
    await sendMessage(operator, `claude#${LABEL}`, `raced at ${offset}`, { operatorThread: true });
    const r = await hook;
    assert.match(r.out, new RegExp(`raced at ${offset}`), "the hold delivers the message");
    const replaced = await old.done;
    assert.notEqual(replaced.code, 2, "the replaced waiter did not wake the session");
    assert.equal(fresh.exited, null, "the waiter started at Stop did not wake the session");
    const end = await fresh.kill();
    assert.doesNotMatch(end.err + replaced.err, new RegExp(`raced at ${offset}`));
  });
}

test("the Stop hook is marked as running before it records the session",{ timeout: 30000 }, async (t) => {
  const { env, cfg } = await setup(t);
  await requestWait(cfg);
  const record = join(cfg.stateDir, cfg.project, "registry", `claude#${LABEL}.json`);
  const hook = runHook(env, ["--host", "claude"], { hook_event_name: "Stop", session_id: SESSION_ID, cwd: "/tmp", stop_hook_active: false });
  let markedAtRecord = null;
  for (let i = 0; i < 5000 && markedAtRecord === null; i++) {
    const marked = stopHookRunning(cfg);
    if (existsSync(record)) markedAtRecord = marked;
    else await delay(1);
  }
  assert.equal(markedAtRecord, true, "the waiter already yields when the session record appears");
  await hook;
  assert.equal(stopHookRunning(cfg), false, "the marker is gone once the hook ends");
});

test("a waiter started at Stop leaves a waiting message alone until the Stop hook has marked itself", { timeout: 30000 }, async (t) => {
  const { env, cfg, operator } = await setup(t);
  await sendMessage(operator, `claude#${LABEL}`, "waiting at stop", { operatorThread: true });
  const waiter = startRewake(t, { ...env, AI_COLLAB_WAITER_MAX_S: "20" }, { hook_event_name: "Stop", session_id: SESSION_ID, cwd: "/tmp" });
  // The Stop hook marks itself inside the waiter's grace window.
  await delay(1000);
  const own = writeMarker(cfg, process.pid);
  await delay(2500);
  assert.equal(waiter.exited, null, "the waiter has not woken the session");
  assert.equal(readJsonFile(handoffFile(cfg)), null, "the waiter claimed nothing: the message is still in the inbox for the hold");
  rmSync(own, { force: true });
  const r = await waiter.done;
  assert.equal(r.code, 2);
  assert.match(r.err, /waiting at stop/);
});

test("a waiter that claims just as a Stop hook marks itself hands the messages to the hold", { timeout: 20000 }, async (t) => {
  const { cfg, operator } = await setup(t);
  await requestWait(cfg);
  await sendMessage(operator, `claude#${LABEL}`, "handed over", { operatorThread: true });
  let holding = false;
  const waiting = runWaiter(cfg, { maxMs: 4000, settleMs: 600, held: () => holding });
  await delay(300);
  holding = true;
  const stop = await decideStop(cfg, { host: "claude", input: { stop_hook_active: false }, sliceMaxS: 6, queued: null });
  assert.equal(stop.why, "messages");
  assert.match(stop.text, /handed over/);
  assert.equal((await waiting).code, 0);
  assert.equal(readJsonFile(handoffFile(cfg)), null, "the hold took the handed-over messages");
});

test("messages handed to a hold that ended without them wake the session through the next waiter", { timeout: 15000 }, async (t) => {
  const { cfg, operator } = await setup(t);
  await sendMessage(operator, `claude#${LABEL}`, "left over", { operatorThread: true });
  let holding = false;
  const first = runWaiter(cfg, { maxMs: 1500, settleMs: 300, held: () => holding });
  await delay(100);
  holding = true;
  assert.equal((await first).code, 0);
  const r = await runWaiter(cfg, { maxMs: 3000 });
  assert.equal(r.code, 2);
  assert.match(r.text, /left over/);
});
