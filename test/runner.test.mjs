import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { readOwned, standsDown } from "../lib/owned.mjs";
import { listSessions } from "../lib/sessions.mjs";
import { settleReceipts } from "../lib/receipts.mjs";
import { eventToEnvelope } from "../lib/agui.mjs";
import { openDurable } from "../runner/durable.mjs";
import { createRunner } from "../runner/runner.mjs";
import { createFakeAdapter } from "../runner/adapters/fake.mjs";
import { listenControl } from "../runner/control.mjs";
import { runnerClient } from "../runner/client.mjs";
import { loadAdapters } from "../runner/main.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ACTIVITY = "ai-collab-demo--activity";
const BROADCAST = "ai-collab-demo--to--all";

// A throwaway HOME with projects.json, a state dir, a durable log file and a project config on the fake ntfy.
function setup(fake) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-runner-"));
  const root = path.join(home, "demo");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), AI_COLLAB_URL: fake.url,
    AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "runner", AI_COLLAB_PEERS: "codex,claude,operator,runner",
    AI_COLLAB_STATE_DIR: path.join(home, "state"), AI_COLLAB_TIMEOUT_MS: "2000",
  };
  const cfg = loadConfig(env, { cwd: root });
  assert.equal(cfg.enabled, true, cfg.reason);
  return { home, root, env, cfg, db: path.join(home, "state", "runner.db") };
}

function makeRunner(ctx, adapter, { watch = false } = {}) {
  const durable = openDurable(ctx.db);
  const runner = createRunner({ projects: [ctx.cfg], adapters: new Map([[adapter.harness, adapter]]), durable, env: ctx.env, startGapMs: 0, watch });
  return runner;
}

async function until(check, what, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const envelopes = (fake, topic) => fake.state.publishes.filter((p) => p.topic === topic).map((p) => eventToEnvelope(p.message)).filter(Boolean);
const rows = (fake) => fake.state.publishes.filter((p) => p.topic === ACTIVITY).map((p) => eventToEnvelope(p.message));

test("start opens a session, claims the registry, and publishes prompt, text and stop rows", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const adapter = createFakeAdapter({ harness: "codex" });
  const runner = makeRunner(ctx, adapter);
  await runner.boot();
  try {
    const started = await runner.start({ project: "demo", harness: "codex", prompt: "hello there" });
    assert.equal(started.status, "started");
    const label = sessionLabel(started.nativeId);
    assert.equal(started.session, `codex#${label}`);
    await until(() => rows(fake).some((r) => r.type === "stop"), "stop row");
    await runner.settle();
    const mine = rows(fake).filter((r) => r.session === label);
    assert.deepEqual(mine.map((r) => r.type), ["text", "prompt", "text", "stop"]);
    assert.equal(mine[0].tool, "Notification");
    assert.equal(mine[2].output, "echo: hello there");
    assert.ok(mine.every((r) => r.from === "codex" && r.harness === "codex"));
    const record = readOwned(ctx.cfg, label);
    assert.equal(record.status, "idle");
    assert.equal(record.permissionMode, "auto");
    assert.equal(adapter.calls[0].options.permission.approvalsReviewer, "auto_review");
    assert.equal(adapter.calls[0].options.env.AI_COLLAB_OWNED, undefined);
    const listed = listSessions({ ...ctx.cfg, peers: [] }).find((s) => s.id === started.session);
    assert.equal(listed.online, true);
    const status = envelopes(fake, "ai-collab-demo--status").filter((e) => e.session === label).map((e) => e.event);
    assert.deepEqual(status, ["start", "stop"]);
  } finally {
    await runner.stop();
    await fake.close();
  }
});

test("hooks stand down for the owned session only; an agent started inside it reports as its child", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const runner = makeRunner(ctx, createFakeAdapter({ harness: "codex" }));
  await runner.boot();
  try {
    const { nativeId } = await runner.start({ project: "demo", harness: "codex", prompt: "hi" });
    await until(() => readOwned(ctx.cfg, sessionLabel(nativeId))?.status === "idle", "idle");
    await runner.settle();
    // The fake ntfy runs in this process, so the hook must run without blocking the event loop.
    const hook = (sessionId, extra = {}) => new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT, "scripts", "ai-collab-hook.mjs"), "--host", "codex"], { env: { ...ctx.env, AI_COLLAB_PEER: "codex", ...extra } });
      let stdout = "";
      child.stdout.on("data", (c) => { stdout += c; });
      child.on("close", () => resolve(stdout.trim()));
      child.stdin.end(JSON.stringify({ hook_event_name: "PostToolUse", session_id: sessionId, cwd: ctx.root, tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "ok" }));
    });
    const before = rows(fake).length;
    assert.equal(await hook(nativeId), "{}");
    assert.equal(rows(fake).length, before);
    await hook("nested-x", { AI_COLLAB_PARENT: `codex#${sessionLabel(nativeId)}` });
    const afterNested = rows(fake).length;
    assert.ok(afterNested > before, "a same-harness agent inside the owned session publishes");
    await hook("terminal-y");
    assert.ok(rows(fake).length > afterNested, "a terminal session still publishes");
    assert.equal(standsDown(ctx.cfg, { label: sessionLabel("terminal-y") }), false);
    assert.equal(standsDown(ctx.cfg, { label: sessionLabel(nativeId) }), true);
  } finally {
    await runner.stop();
    await fake.close();
  }
});

test("an approval becomes an owned card; a phone reply allows it and closes the card", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const adapter = createFakeAdapter({ harness: "claude" });
  const runner = makeRunner(ctx, adapter, { watch: true });
  await runner.boot();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const { nativeId, session } = await runner.start({ project: "demo", harness: "claude", prompt: "approve: rm -rf build" });
    const card = await until(() => envelopes(fake, BROADCAST).find((e) => e.kind === "approval"), "approval card");
    assert.equal(card.owned, true);
    assert.equal(card.session, sessionLabel(nativeId));
    assert.equal(card.tool, "Bash");
    assert.equal(card.summary, "rm -rf build");
    assert.deepEqual(runner.get(session).approvals.map((a) => a.id), [card.id]);
    fake.inject(BROADCAST, `reply ${card.id} allow`);
    const end = await until(() => envelopes(fake, BROADCAST).find((e) => e.kind === "approval-end"), "approval-end");
    assert.deepEqual([end.id, end.reason], [card.id, "allowed"]);
    await until(() => rows(fake).some((r) => r.type === "tool_result" && r.output === "ran rm -rf build"), "tool result");
    assert.equal(adapter.calls.find((c) => c.op === "respond").decision.behavior, "allow");
    assert.equal(readOwned(ctx.cfg, sessionLabel(nativeId)).permissionMode, "auto");
  } finally {
    await runner.stop();
    await fake.close();
  }
});

test("input during a run queues durably; interrupt ends the run and the queue runs next", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const adapter = createFakeAdapter({ harness: "codex" });
  const runner = makeRunner(ctx, adapter);
  await runner.boot();
  try {
    const { session } = await runner.start({ project: "demo", harness: "codex", prompt: "hang please" });
    await until(() => runner.get(session).status === "running", "running");
    assert.deepEqual(await runner.send(session, { text: "next one" }), { status: "queued" });
    assert.deepEqual(await runner.send(session, { text: "nudge", steer: true }), { status: "steered" });
    assert.deepEqual(await runner.interrupt(session), { status: "interrupting" });
    await until(() => adapter.calls.filter((c) => c.op === "send").length === 2, "queued send");
    assert.equal(adapter.calls.filter((c) => c.op === "send")[1].text, "next one");
    await until(() => rows(fake).some((r) => r.type === "text" && r.output === "echo: next one"), "second run");
    assert.ok(rows(fake).some((r) => r.type === "stop" && r.input === "turn ended · interrupted"));
    assert.deepEqual(await runner.close(session), { status: "ended" });
    await runner.settle();
    assert.ok(rows(fake).some((r) => r.type === "stop" && r.input === "session ended · closed by the operator"));
    assert.equal(standsDown(ctx.cfg, { label: session.split("#")[1] }), false);
  } finally {
    await runner.stop();
    await fake.close();
  }
});

test("a restart cuts a run as interrupted, never resends it, and resumes the session on the next input", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const first = makeRunner(ctx, createFakeAdapter({ harness: "claude" }));
  await first.boot();
  const { session, nativeId } = await first.start({ project: "demo", harness: "claude", prompt: "hang until cut" });
  await until(() => first.get(session).run, "run").finally(() => first.stop());

  const adapter = createFakeAdapter({ harness: "claude" });
  const second = makeRunner(ctx, adapter);
  try {
    assert.equal((await second.boot()).length, 1);
    await until(() => second.get(session).cut, "cut");
    await second.settle();
    assert.equal(second.get(session).status, "idle");
    assert.ok(rows(fake).some((r) => r.type === "stop" && r.input === "turn ended · interrupted · runner restarted"));
    assert.deepEqual(adapter.calls, []);
    assert.equal((await second.send(session, { text: "carry on" })).status, "sent");
    await until(() => adapter.calls.some((c) => c.op === "send"), "send after resume");
    assert.deepEqual(adapter.calls.map((c) => c.op), ["resume", "send"]);
    assert.equal(adapter.calls[0].nativeId, nativeId);
    assert.deepEqual(adapter.calls[0].resume, { fake: true });
  } finally {
    await second.stop();
    await fake.close();
  }
});

test("an operator message to an owned session becomes its next run and gets a read receipt", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const adapter = createFakeAdapter({ harness: "codex" });
  const runner = makeRunner(ctx, adapter, { watch: true });
  await runner.boot();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const { session, nativeId } = await runner.start({ project: "demo", harness: "codex", prompt: "first" });
    await until(() => runner.get(session).status === "idle", "idle");
    const label = sessionLabel(nativeId);
    const ev = fake.inject("ai-collab-demo--to--codex", JSON.stringify({ v: 1, kind: "msg", from: "operator", to: "codex", toSession: label, operatorThread: true, ts: new Date().toISOString(), body: "please add tests" }));
    await until(() => adapter.calls.filter((c) => c.op === "send").length === 2, "delivery");
    const text = adapter.calls.filter((c) => c.op === "send")[1].text;
    assert.match(text, /please add tests/);
    assert.match(text, /reply_to_operator/);
    await settleReceipts();
    const receipt = await until(() => envelopes(fake, "ai-collab-demo--receipts").find((e) => e.ids.includes(ev.id)), "receipt");
    assert.equal(receipt.session, label);
  } finally {
    await runner.stop();
    await fake.close();
  }
});

test("project-chat broadcasts reach every owned session; a session's own broadcast does not", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const adapter = createFakeAdapter({ harness: "codex" });
  const runner = makeRunner(ctx, adapter, { watch: true });
  await runner.boot();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const a = await runner.start({ project: "demo", harness: "codex", prompt: "first a" });
    const b = await runner.start({ project: "demo", harness: "codex", prompt: "first b" });
    await until(() => runner.get(a.session).status === "idle" && runner.get(b.session).status === "idle", "both idle");
    const sends = () => adapter.calls.filter((c) => c.op === "send");
    fake.inject(BROADCAST, JSON.stringify({ v: 1, kind: "msg", from: "claude", session: "0123456789abcdef", to: "all", ts: new Date().toISOString(), body: "team update" }));
    await until(() => sends().filter((c) => /team update/.test(c.text)).length === 2, "envelope broadcast to both");
    fake.inject(BROADCAST, "operator typed this");
    await until(() => sends().filter((c) => /operator typed this/.test(c.text)).length === 2, "plain broadcast to both");
    fake.inject(BROADCAST, JSON.stringify({ v: 1, kind: "msg", from: "codex", session: sessionLabel(a.nativeId), to: "all", ts: new Date().toISOString(), body: "from a" }));
    await until(() => sends().filter((c) => /from a/.test(c.text)).length === 1, "own broadcast reaches the other session only");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(sends().filter((c) => /from a/.test(c.text)).length, 1);
  } finally {
    await runner.stop();
    await fake.close();
  }
});

test("an unanswered owned approval is denied after the timeout", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const adapter = createFakeAdapter({ harness: "claude" });
  const runner = createRunner({ projects: [ctx.cfg], adapters: new Map([["claude", adapter]]), durable: openDurable(ctx.db), env: ctx.env, startGapMs: 0, watch: false, approvalMs: 100 });
  await runner.boot();
  try {
    await runner.start({ project: "demo", harness: "claude", prompt: "approve: rm -rf build" });
    const card = await until(() => envelopes(fake, BROADCAST).find((e) => e.kind === "approval"), "approval card");
    assert.ok(card.expiresAt - Date.parse(card.ts) <= 100);
    const end = await until(() => envelopes(fake, BROADCAST).find((e) => e.kind === "approval-end"), "approval-end");
    assert.deepEqual([end.id, end.reason], [card.id, "denied"]);
    assert.equal(adapter.calls.find((c) => c.op === "respond").decision.behavior, "deny");
  } finally {
    await runner.stop();
    await fake.close();
  }
});

test("the operator changes a session's mode over the control socket; defaults follow place", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const adapter = createFakeAdapter({ harness: "opencode" });
  const runner = makeRunner(ctx, adapter);
  await runner.boot();
  const socket = path.join(ctx.home, "run", "runner.sock");
  const control = await listenControl(runner, socket);
  const client = runnerClient({ socket });
  try {
    const { session, nativeId } = await runner.start({ project: "demo", harness: "opencode", prompt: "hi" });
    assert.equal(runner.get(session).permissionMode, "supervised");
    const changed = await client.setMode(session, "accept-edits");
    assert.deepEqual([changed.status, changed.body], [200, { status: "changed", permissionMode: "accept-edits" }]);
    assert.deepEqual(adapter.calls.find((c) => c.op === "setPermissionMode"), { op: "setPermissionMode", nativeId, mode: "accept-edits" });
    assert.equal(readOwned(ctx.cfg, sessionLabel(nativeId)).permissionMode, "accept-edits");
    assert.equal((await client.setMode(session, "auto")).status, 400);
    assert.equal((await client.setMode(session, "bogus")).status, 400);
    assert.equal((await client.setMode("opencode#0000000000000000", "supervised")).status, 404);
    await assert.rejects(runner.start({ project: "demo", harness: "opencode", prompt: "x", place: "openshell" }), /openshell/);
  } finally {
    await control.close();
    await runner.stop();
    await fake.close();
  }
});

test("the control socket serves health, start, list, session reads and errors", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const runner = makeRunner(ctx, createFakeAdapter({ harness: "codex" }));
  await runner.boot();
  const socket = path.join(ctx.home, "run", "runner.sock");
  const control = await listenControl(runner, socket);
  const client = runnerClient({ socket });
  try {
    assert.deepEqual((await client.health()).body, { ok: true, version: 1, harnesses: ["codex"] });
    const started = await client.start({ project: "demo", harness: "codex", prompt: "via socket" });
    assert.equal(started.status, 201);
    assert.equal((await client.sessions()).body.sessions[0].session, started.body.session);
    assert.equal((await client.get(started.body.session)).body.harness, "codex");
    assert.deepEqual((await client.models("codex")).body, { models: [{ id: "fake-1", default: true }] });
    assert.equal((await client.commands("codex", "demo")).body.commands[0].name, "/fake");
    assert.equal((await client.start({ project: "demo", harness: "cursor", prompt: "x" })).status, 400);
    assert.equal((await client.start({ project: "demo", harness: "codex", prompt: "-rf" })).status, 400);
    assert.equal((await client.get("codex#0000000000000000")).status, 404);
    assert.equal((await client.get("nope#zz")).status, 400);
    await assert.rejects(listenControl(runner, socket), /another runner/);
  } finally {
    await control.close();
    await runner.stop();
    await fake.close();
  }
});

test("cursor full-access is refused outside openshell, and missing adapter modules are skipped", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const runner = makeRunner(ctx, createFakeAdapter({ harness: "cursor" }));
  try {
    await assert.rejects(runner.start({ project: "demo", harness: "cursor", prompt: "x", permissionMode: "full-access" }), /runs only in openshell/);
    const dir = mkdtempSync(path.join(os.tmpdir(), "ai-collab-adapters-"));
    writeFileSync(path.join(dir, "codex.mjs"), "export default () => ({ harness: 'codex' });\n");
    const skipped = [];
    const loaded = await loadAdapters(["codex", "claude"], { dir, log: (m) => skipped.push(m) });
    assert.deepEqual([...loaded.keys()], ["codex"]);
    assert.deepEqual(skipped, ["no claude adapter yet"]);
  } finally {
    await runner.stop();
    await fake.close();
  }
});

test("main serves the control socket with no adapters and exits on SIGTERM", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const socket = path.join(ctx.home, "run", "runner.sock");
  const child = spawn(process.execPath, [path.join(ROOT, "runner", "main.mjs")], { env: { ...ctx.env, AI_COLLAB_RUNNER_SOCKET: socket, AI_COLLAB_RUNNER_DB: ctx.db } });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c; });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  try {
    await until(() => stderr.includes("listening on"), "listening", 8000);
    assert.match(stderr, /no codex adapter yet/);
    assert.deepEqual((await runnerClient({ socket }).health()).body, { ok: true, version: 1, harnesses: [] });
    child.kill("SIGTERM");
    assert.equal(await exited, 0);
  } finally {
    child.kill("SIGKILL");
    await fake.close();
  }
});
