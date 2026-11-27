import { parseWireEnvelope } from "../lib/agui.ts";
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, sessionLabel } from "../lib/config.ts";
import { claimInbox, MESSAGE_MAX_BYTES, sendMessage } from "../lib/inbox.mjs";
import { operatorPrompt, WAKE_PROMPT } from "../lib/mode.ts";
import { askQuestion, requestWait } from "../lib/questions.ts";
import { lastOperatorPromptAt, recordSession } from "../lib/sessions.mjs";
import { decideStop } from "../lib/stop.ts";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { queuedByOperator, watchQueue } from "../lib/transcript.ts";
import { fileEnd, tempDir } from "./helpers/tmp.mjs";

const enqueue = (content) => JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: new Date().toISOString(), sessionId: "s", content }) + "\n";

test("a Claude transcript watch sees only prompts the operator queued after the wait began", () => {
  const dir = tempDir({ after }, "ai-collab-transcript-");
  const file = path.join(dir, "t.jsonl");
  writeFileSync(file, enqueue("queued before the wait") + "{\"type\":\"user\"}\n");
  assert.equal(watchQueue("cursor", { transcript_path: file }), null, "no signal for Cursor");
  assert.equal(watchQueue("claude", { transcript_path: path.join(dir, "missing.jsonl") }), null, "a missing file waits as before");
  assert.equal(watchQueue("claude", { transcript_path: "relative.jsonl" }), null);
  const queued = watchQueue("claude", { transcript_path: file }, { env: {} });
  assert.equal(queued(), false);
  appendFileSync(file, "not json\n" + enqueue("<task-notification>\n<task-id>x</task-id>") + enqueue("<agent-message from=\"a\">hi")
    + enqueue("[ai-collab] continuation") + enqueue("Another Claude session sent a message") + JSON.stringify({ type: "queue-operation", operation: "dequeue" }) + "\n");
  assert.equal(queued(), false, "machinery and other agents do not count");
  appendFileSync(file, enqueue("Really? I would").slice(0, 40));
  assert.equal(queued(), false, "a half-written line waits for its end");
  appendFileSync(file, enqueue("Really? I would").slice(40));
  assert.equal(queued(), true);
  assert.equal(queuedByOperator("  typed", {}), true);
  assert.equal(queuedByOperator(undefined, {}), false);
});

test("a Codex AFK Stop wait ends when history.jsonl records a prompt for that session after the wait began", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const codexHome = tempDir(fileEnd, "ai-collab-codex-home-");
  const history = path.join(codexHome, "history.jsonl");
  const line = (session_id, ts, text) => JSON.stringify({ session_id, ts, text }) + "\n";
  const nowS = () => Math.floor(Date.now() / 1000);
  writeFileSync(history, line("thread-1", nowS() - 5, "typed before the wait"));
  assert.equal(watchQueue("codex", { session_id: "thread-1" }, { env: { CODEX_HOME: path.join(codexHome, "missing") } }), null, "no history file: wait as before");
  const check = watchQueue("codex", { session_id: "thread-1" }, { env: { CODEX_HOME: codexHome } });
  appendFileSync(history, line("thread-2", nowS(), "another session") + line("thread-1", nowS() - 60, "older entry")
    + line("thread-1", nowS(), "[ai-collab] continuation") + "garbage\n");
  assert.equal(check(), false);
  appendFileSync(history, line("thread-1", nowS(), "Stop waiting, I'm here"));
  assert.equal(check(), true);

  const env = peerEnv(fake, { peer: "codex", AI_COLLAB_SESSION: "aabbccddeeff0888", CODEX_HOME: codexHome });
  const cfg = loadConfig(env);
  setMode(fake, "on");
  await claimInbox(cfg);
  setTimeout(() => appendFileSync(history, line("thread-1", nowS(), "back at the terminal")), 500);
  const queued = watchQueue("codex", { session_id: "thread-1" }, { env });
  const started = Date.now();
  const decided = decideStop(cfg, { host: "codex", input: { stop_hook_active: false, session_id: "thread-1" }, queued });
  const guard = new Promise((_, reject) => setTimeout(() => reject(new Error("still waiting")), 5000).unref());
  assert.deepEqual(await Promise.race([decided, guard]), { action: "stop" });
  assert.ok(Date.now() - started < 3000, `released after ${Date.now() - started} ms`);
  assert.deepEqual(modes(fake), [], "AFK stays on");
});

test("an AFK Stop wait ends as soon as the operator queues a prompt in that Claude session, and AFK stays on", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "claude", AI_COLLAB_SESSION: "aabbccddeeff0777" });
  const cfg = loadConfig(env);
  setMode(fake, "on");
  await claimInbox(cfg);
  const file = path.join(tempDir(fileEnd, "ai-collab-transcript-"), "t.jsonl");
  writeFileSync(file, "");
  const started = Date.now();
  setTimeout(() => appendFileSync(file, enqueue("<task-notification>done</task-notification>")), 200);
  setTimeout(() => appendFileSync(file, enqueue("Really? I would have thought…")), 600);
  const decided = decideStop(cfg, { host: "claude", input: { stop_hook_active: false, transcript_path: file } });
  const guard = new Promise((_, reject) => setTimeout(() => reject(new Error("still waiting")), 5000).unref());
  assert.deepEqual(await Promise.race([decided, guard]), { action: "stop" });
  assert.ok(Date.now() - started < 3000, `released after ${Date.now() - started} ms`);
  assert.deepEqual(modes(fake), [], "a queued prompt (terminal or Remote Control) leaves AFK on");
});

const HOOK = fileURLToPath(new URL("../scripts/ai-collab-hook.mjs", import.meta.url));
const ALL = "ai-collab-demo--to--all";

function runHook(args, input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, ...args], { env, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => resolve(JSON.parse(out)));
    child.stdin.end(JSON.stringify(input));
  });
}

const modes = (fake) => fake.state.publishes.filter((p) => p.topic === ALL).map((p) => parseWireEnvelope(p.message)).filter((m) => m?.kind === "mode").map((m) => m.mode);

function setMode(fake, mode) {
  fake.inject(ALL, JSON.stringify({ v: 1, kind: "mode", from: "operator", mode, ts: Date.now() }));
}

// Injected clock: wait(ms) jumps to the next scheduled event or to the deadline.
function clockFor() {
  const clock = { t: Date.now(), slept: 0, events: [] };
  const wait = async (ms) => {
    const next = clock.events.sort((a, b) => a.at - b.at)[0];
    const step = next && next.at - clock.t <= ms ? Math.max(0, next.at - clock.t) : ms;
    clock.t += step;
    clock.slept += step;
    if (next && next.at <= clock.t) {
      clock.events.shift();
      await next.run();
    }
  };
  return { clock, deps: { now: () => clock.t, wait } };
}

test("only prompts the operator typed count: not wake runs, the wake prompt, or ai-collab's injected text", () => {
  assert.equal(operatorPrompt("fix the bug", {}), true);
  assert.equal(operatorPrompt("  [ai-collab] These messages arrived as you were stopping.", {}), false);
  assert.equal(operatorPrompt(WAKE_PROMPT, {}), false);
  assert.equal(operatorPrompt("fix the bug", { AI_COLLAB_WAKE: "1" }), false);
  assert.equal(operatorPrompt("", {}), false);
  assert.equal(operatorPrompt(undefined, {}), false);
});

test("AFK stays on until the operator turns it off: typed prompts in any harness leave it on", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "claude", AI_COLLAB_POLL_INTERVAL_MS: "0" });
  setMode(fake, "on");
  await runHook(["--host", "claude"], { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/tmp", prompt: "I'm on Remote Control" }, env);
  await runHook(["--host", "codex"], { hook_event_name: "UserPromptSubmit", session_id: "s2", cwd: "/tmp", prompt: "typed here" }, { ...env, AI_COLLAB_PEER: "codex" });
  const cursor = await runHook(["--activity", "--host", "cursor"], { hook_event_name: "beforeSubmitPrompt", conversation_id: "c1", cwd: "/tmp", prompt: "hi" }, { ...env, AI_COLLAB_PEER: "cursor" });
  assert.deepEqual(cursor, { continue: true });
  assert.deepEqual(modes(fake), [], "no hook publishes a mode change");
});

test("AFK on holds the Stop hook even right after the operator typed in that session", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const id = "typed-session";
  const cfg = loadConfig(peerEnv(fake, { peer: "alice", AI_COLLAB_SESSION: sessionLabel(id) }));
  setMode(fake, "on");
  await claimInbox(cfg);
  await requestWait(cfg);
  await recordSession(cfg, { id, cwd: "/tmp", harness: "claude", event: "UserPromptSubmit", operatorPromptAt: Date.now() - 1000 });
  assert.ok(lastOperatorPromptAt(cfg) > 0);
  const { clock, deps } = clockFor();
  const waited = await decideStop(cfg, { host: "claude", input: { stop_hook_active: false }, ...deps, sliceMaxS: 30 });
  assert.ok(clock.slept > 0, "the AFK wait runs");
  assert.equal(waited.action, "continue");
});

test("a session waiting in AFK releases when the mode turns off elsewhere", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const cfg = loadConfig(peerEnv(fake, { peer: "alice", AI_COLLAB_SESSION: "aabbccddeeff0999" }));
  setMode(fake, "on");
  await claimInbox(cfg);
  await requestWait(cfg);
  const { clock, deps } = clockFor();
  clock.events.push({ at: clock.t + 60_000, run: async () => setMode(fake, "off") });
  assert.deepEqual(await decideStop(cfg, { host: "claude", input: { stop_hook_active: false }, ...deps }), { action: "stop" });
  assert.equal(clock.slept, 60_000, "stops when the off envelope arrives, not after 10 minutes");
});

test("sendMessage rejects an envelope over the 4095-byte wire cap", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const cfg = loadConfig(peerEnv(fake, { peer: "alice" }));
  assert.equal(MESSAGE_MAX_BYTES, 4095);
  await sendMessage(cfg, "all", "x");
  const overhead = Buffer.byteLength(fake.state.publishes[0].message) - 1;
  // Two-byte characters reach the byte cap within the 4000-character body limit.
  const body = (bytes) => "é".repeat(1000) + "x".repeat(bytes - overhead - 2000);
  await sendMessage(cfg, "all", body(4095));
  assert.equal(Buffer.byteLength(fake.state.publishes[1].message), 4095);
  await assert.rejects(sendMessage(cfg, "all", body(4096)), /4095-byte wire limit/);
});

test("task notifications and agent hand-backs are not operator prompts", () => {
  for (const text of ["<task-notification>\n<task-id>a1</task-id>", "Another Claude session sent a message:\n<agent-message from=\"a1\">report",
    "<cross-session-message from=\"x\">hi", "[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>"]) {
    assert.equal(operatorPrompt(text, {}), false, text);
  }
  assert.equal(operatorPrompt("deploy it", {}), true);
});

test("a Claude or Codex hook run by Cursor (input carries cursor_version) does nothing", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "claude", AI_COLLAB_POLL_INTERVAL_MS: "0" });
  const out = await runHook(["--host", "claude"], { hook_event_name: "sessionStart", session_id: "c1", cwd: "/tmp", cursor_version: "2026.11.19" }, env);
  assert.deepEqual(out, {});
  assert.equal(fake.state.publishes.length, 0);
  await runHook(["--host", "cursor"], { hook_event_name: "sessionStart", conversation_id: "c1", cwd: "/tmp", cursor_version: "2026.11.19" }, { ...env, AI_COLLAB_PEER: "cursor" });
  assert.ok(fake.state.publishes.length > 0, "the Cursor registration still reports");
});
