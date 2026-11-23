import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { sendMessage } from "../lib/inbox.mjs";
import { runWaiter, takeWaiterSlot } from "../lib/waiter.mjs";

const HOOK = fileURLToPath(new URL("../scripts/ai-collab-hook.mjs", import.meta.url));
const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const LABEL = sessionLabel(SESSION_ID);

async function setup(t, extra = {}) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "alice", ...extra });
  const cfg = loadConfig(env, { session: LABEL });
  const bob = loadConfig(peerEnv(fake, { peer: "bob", AI_COLLAB_STATE_DIR: env.AI_COLLAB_STATE_DIR }));
  return { fake, env, cfg, bob };
}

function runRewake(env, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, "--rewake", "--host", "claude"], { env, stdio: ["pipe", "pipe", "pipe"] });
    const result = { out: "", err: "" };
    child.stdout.on("data", (d) => { result.out += d; });
    child.stderr.on("data", (d) => { result.err += d; });
    child.on("close", (code) => resolve({ ...result, code }));
    child.stdin.end(JSON.stringify(input));
  });
}

test("runWaiter claims a waiting message at once and returns exit code 2 with the formatted inbox", async (t) => {
  const { cfg, bob } = await setup(t);
  await sendMessage(bob, `alice#${LABEL}`, "review PR 12");
  const r = await runWaiter(cfg, { maxMs: 5000 });
  assert.equal(r.code, 2);
  assert.match(r.text, /from=bob/);
  assert.match(r.text, /body="review PR 12"/);
  assert.match(r.text, /Your sender identity is alice#/);
});

test("runWaiter wakes on a message that arrives on the stream", async (t) => {
  const { cfg, bob } = await setup(t);
  const waiting = runWaiter(cfg, { maxMs: 8000 });
  setTimeout(() => sendMessage(bob, `alice#${LABEL}`, "late news"), 300);
  const r = await waiting;
  assert.equal(r.code, 2);
  assert.match(r.text, /late news/);
  assert.equal((await runWaiter(cfg, { maxMs: 200 })).code, 0, "the message was claimed once");
});

test("runWaiter does not wake for an fyi message and leaves it unclaimed", async (t) => {
  const { cfg, bob } = await setup(t);
  await sendMessage(bob, `alice#${LABEL}`, "no rush", { priority: "fyi" });
  assert.deepEqual(await runWaiter(cfg, { maxMs: 400 }), { code: 0 });
  const left = await (await import("../lib/inbox.mjs")).claimInbox(cfg);
  assert.equal(left.length, 1);
  assert.equal(left[0].priority, "fyi");
});

test("runWaiter ends quietly when the harness is gone or the time is up", async (t) => {
  const { cfg } = await setup(t);
  assert.deepEqual(await runWaiter(cfg, { maxMs: 60_000, alive: () => false, wait: async () => "timeout" }), { code: 0 });
  assert.deepEqual(await runWaiter(cfg, { maxMs: 100, wait: async () => "timeout" }), { code: 0 });
});

test("a new waiter stops the previous one and the slot belongs to the newest", async (t) => {
  const { cfg } = await setup(t);
  const old = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  t.after(() => old.kill());
  const exited = new Promise((resolve) => old.once("exit", (code, signal) => resolve(signal)));
  await takeWaiterSlot(cfg, { pid: old.pid });
  const release = await takeWaiterSlot(cfg);
  assert.equal(await exited, "SIGTERM");
  release();
});

test("hook --rewake exits 2 with the message on stderr, no stdout JSON", { timeout: 15000 }, async (t) => {
  const { env, bob } = await setup(t);
  await sendMessage(bob, `alice#${LABEL}`, "wake up");
  const r = await runRewake({ ...env, AI_COLLAB_WAITER_MAX_S: "5" }, { hook_event_name: "Stop", session_id: SESSION_ID, cwd: "/tmp" });
  assert.equal(r.code, 2);
  assert.match(r.err, /body="wake up"/);
  assert.equal(r.out, "");
});

test("hook --rewake exits 0 and prints nothing when nothing arrives before its limit", { timeout: 15000 }, async (t) => {
  const { env } = await setup(t);
  const r = await runRewake({ ...env, AI_COLLAB_WAITER_MAX_S: "1" }, { hook_event_name: "SessionStart", session_id: SESSION_ID, cwd: "/tmp" });
  assert.deepEqual([r.code, r.out, r.err], [0, "", ""]);
});

test("hook --rewake does nothing for a subagent", { timeout: 15000 }, async (t) => {
  const { env, bob } = await setup(t);
  await sendMessage(bob, `alice#${LABEL}`, "for the parent");
  const r = await runRewake({ ...env, AI_COLLAB_WAITER_MAX_S: "5" }, {
    hook_event_name: "UserPromptSubmit", session_id: SESSION_ID, cwd: "/tmp", agent_id: "a1b2c3",
  });
  assert.deepEqual([r.code, r.out, r.err], [0, "", ""]);
});

// Runs the rewake hook under a parent whose argv is `claude <args>`, as harnessProcess finds it in /proc.
function runRewakeUnderClaude(env, input, args) {
  const wrapper = `const { spawn } = require("node:child_process"); const c = spawn(process.execPath, [${JSON.stringify(HOOK)}, "--rewake", "--host", "claude"], { stdio: ["pipe", "inherit", "inherit"] }); c.stdin.end(${JSON.stringify(JSON.stringify(input))}); c.on("close", (code) => process.exit(code));`;
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", `exec -a claude "${process.execPath}" -e '${wrapper.replace(/'/g, "'\\''")}' -- "$@"`, "bash", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ code, err }));
  });
}

test("rewake stands down in a headless claude -p run, where an exit 2 would block the prompt", async (t) => {
  const { env, bob } = await setup(t);
  await sendMessage(bob, `alice#${LABEL}`, "ping");
  const input = { session_id: SESSION_ID, hook_event_name: "UserPromptSubmit", cwd: process.cwd() };
  const headless = await runRewakeUnderClaude(env, input, ["-p", "do it"]);
  assert.equal(headless.code, 0, headless.err);
  const interactive = await runRewakeUnderClaude(env, input, []);
  assert.equal(interactive.code, 2, "an interactive session is still woken");
});
