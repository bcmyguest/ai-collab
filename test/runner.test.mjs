import { parseWireEnvelope } from "../lib/agui.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { cursorBinary } from "../lib/start.mjs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { readOwned, standsDown, writeOwned } from "../lib/sessions/registry.ts";
import { listSessions } from "../lib/sessions.mjs";
import { openTasks } from "../lib/tasks.mjs";
import { builderPaths } from "../lib/builder.mjs";
import { setProjectPaused } from "../lib/project-pause.ts";
import { settleReceipts } from "../lib/receipts.mjs";
import { openDurable } from "../runner/durable.mjs";
import { createRunner } from "../runner/runner.mjs";
import { createFakeAdapter } from "../runner/adapters/fake.mjs";
import cursorAdapter, { sandboxName } from "../runner/adapters/cursor.mjs";
import { wrapOpen } from "./helpers/fake-adapter-hooks.mjs";
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

const envelopes = (fake, topic) => fake.state.publishes.filter((p) => p.topic === topic).map((p) => parseWireEnvelope(p.message)).filter(Boolean);
const rows = (fake) => fake.state.publishes.filter((p) => p.topic === ACTIVITY).map((p) => parseWireEnvelope(p.message));

test("boot releases the slot of an owned builder whose workflow failed", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const label = "0123456789abcdef";
  const address = `codex#${label}`;
  const id = "interrupted-build";
  const workflowId = "session-failed-builder";
  const paths = builderPaths(id, ctx.env);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.state, JSON.stringify({ id, project: "demo", harness: "codex", owned: true, address, phase: "staging", sandboxCreated: true }));
  writeOwned(ctx.cfg, {
    project: "demo", harness: "codex", label, address, nativeId: "builder-native-id", cwd: ctx.root,
    workflowId, builder: id, status: "idle", approvals: [],
  });
  const durable = openDurable(ctx.db);
  durable.register("session", async () => { throw new Error("ENOSPC: no space left on device, write"); });
  await assert.rejects(durable.startWorkflow("session", workflowId, {}), /ENOSPC/);
  await durable.close();
  const runner = makeRunner(ctx, createFakeAdapter({ harness: "codex" }));
  try {
    await runner.boot();
    const state = JSON.parse(readFileSync(paths.state, "utf8"));
    assert.equal(state.phase, "failed");
    assert.match(state.error, /ENOSPC/);
    assert.equal(state.sandboxCreated, true);
    assert.equal(readOwned(ctx.cfg, label).status, "ended");
  } finally {
    await runner.stop();
    await fake.close();
    rmSync(ctx.home, { recursive: true, force: true });
  }
});

test("start opens a session, claims the registry, and publishes prompt, text and stop rows", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const adapter = createFakeAdapter({ harness: "codex" });
  const runner = makeRunner(ctx, adapter);
  await runner.boot();
  try {
    const input = { project: "demo", harness: "codex", prompt: "hello there", taskId: "handoff" };
    await assert.rejects(runner.start(input), { status: 400, message: "Unknown task in this project" });
    await openTasks("demo", ctx.env).add({ id: "handoff", title: "Handoff" });
    setProjectPaused(ctx.cfg, true);
    await assert.rejects(runner.start(input), { status: 409, message: "New work is paused for this project" });
    await assert.rejects(runner.continueBuilder(input), { status: 409, message: "New work is paused for this project" });
    setProjectPaused(ctx.cfg, false);
    const started = await runner.start(input);
    assert.equal(started.taskId, "handoff");
    assert.equal(runner.get(started.session).taskId, "handoff");
    assert.equal(readOwned(ctx.cfg, sessionLabel(started.nativeId)).taskId, "handoff");
    assert.equal(started.status, "started");
    const label = sessionLabel(started.nativeId);
    assert.equal(started.session, `codex#${label}`);
    await until(() => rows(fake).some((r) => r.type === "stop"), "stop row");
    await runner.settle();
    const mine = rows(fake).filter((r) => r.session === label);
    assert.deepEqual(mine.map((r) => r.type), ["text", "prompt", "text", "stop"]);
    assert.equal(mine[0].tool, "Notification");
    assert.equal(mine[1].system, true);
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

test("compact on an idle owned session compacts in place and reports the counts", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const adapter = createFakeAdapter({ harness: "claude" });
  const runner = makeRunner(ctx, adapter);
  await runner.boot();
  try {
    const { session } = await runner.start({ project: "demo", harness: "claude", prompt: "hi" });
    await until(() => runner.get(session).status === "idle", "idle");
    const result = await runner.compact(session);
    assert.equal(result.status, "succeeded");
    assert.equal(result.before, 90000);
    assert.equal(result.after, 20000);
    assert.match(result.detail, /90000 → 20000 tokens/);
    assert.ok(adapter.calls.some((c) => c.op === "compact"), "the adapter's own compaction ran");
  } finally {
    await runner.stop();
    await fake.close();
  }
});

test("compact refuses while a turn runs, and reports unsupported when the adapter has no trigger", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const adapter = createFakeAdapter({ harness: "codex" });
  const runner = makeRunner(ctx, adapter);
  await runner.boot();
  try {
    const { session } = await runner.start({ project: "demo", harness: "codex", prompt: "hang" });
    await until(() => runner.get(session).status === "running", "running");
    await assert.rejects(() => runner.compact(session), /mid-turn/);
  } finally {
    await runner.stop();
    await fake.close();
  }

  // A harness with no adapter trigger reports unsupported rather than posting a message.
  const fake2 = await startFakeNtfy();
  const ctx2 = setup(fake2);
  const bare = createFakeAdapter({ harness: "cursor", compact: false });
  const runner2 = makeRunner(ctx2, bare);
  await runner2.boot();
  try {
    const { session } = await runner2.start({ project: "demo", harness: "cursor", prompt: "hi" });
    await until(() => runner2.get(session).status === "idle", "idle");
    assert.equal((await runner2.compact(session)).status, "unsupported");
  } finally {
    await runner2.stop();
    await fake2.close();
  }
});

test("hooks stand down for the owned session only; an agent started inside it reports as its child", async () => {  const fake = await startFakeNtfy();
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

test("a project-chat post reaches an owned session only when it @mentions that session or its harness", async () => {
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
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(sends().filter((c) => /team update/.test(c.text)).length, 0, "an unmentioned broadcast reaches no session");
    fake.inject(BROADCAST, JSON.stringify({ v: 1, kind: "msg", from: "claude", session: "0123456789abcdef", to: "all", ts: new Date().toISOString(), body: "@codex team update" }));
    await until(() => sends().filter((c) => /@codex team update/.test(c.text)).length === 2, "a harness mention reaches both");
    fake.inject(BROADCAST, "operator typed this");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(sends().filter((c) => /operator typed this/.test(c.text)).length, 0, "plain text with no mention reaches no session");
    fake.inject(BROADCAST, "@codex operator typed this");
    await until(() => sends().filter((c) => /@codex operator typed this/.test(c.text)).length === 2, "a plain mention reaches both");
    fake.inject(BROADCAST, JSON.stringify({ v: 1, kind: "msg", from: "codex", session: sessionLabel(a.nativeId), to: "all", ts: new Date().toISOString(), body: "@codex from a" }));
    await until(() => sends().filter((c) => /@codex from a/.test(c.text)).length === 1, "own broadcast reaches the other session only");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(sends().filter((c) => /@codex from a/.test(c.text)).length, 1);
  } finally {
    await runner.stop();
    await fake.close();
  }
});

test("a start-only post (only @harness:model tags) reaches no owned session", async () => {
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
    const startOnly = JSON.stringify({
      v: 1, kind: "msg", from: "operator", to: "all", startOnly: true, ts: new Date().toISOString(), body: "@codex:gpt-5-codex build it",
    });
    fake.inject(BROADCAST, startOnly);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(sends().filter((c) => /build it/.test(c.text)).length, 0, "a start-only post reaches no owned session");
    // The same words without the mark, and without a mention, still reach nobody.
    fake.inject(BROADCAST, JSON.stringify({ v: 1, kind: "msg", from: "operator", to: "all", ts: new Date().toISOString(), body: "build it" }));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(sends().filter((c) => /build it/.test(c.text)).length, 0, "an unmentioned broadcast reaches no owned session");
    fake.inject(BROADCAST, JSON.stringify({ v: 1, kind: "msg", from: "operator", to: "all", ts: new Date().toISOString(), body: "@codex build it now" }));
    await until(() => sends().filter((c) => /@codex build it now/.test(c.text)).length === 2, "a harness mention reaches both");
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

test("starting a Cursor session in OpenShell defaults to full-access and completes an ACP turn", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const helper = (name) => path.join(ROOT, "test", "helpers", name);
  Object.assign(ctx.env, {
    AI_COLLAB_CURSOR_BIN: helper("fake-cursor-agent.mjs"),
    AI_COLLAB_OPENSHELL_BIN: helper("fake-openshell.mjs"),
    FAKE_SANDBOX_CURSOR_BIN: helper("fake-cursor-agent.mjs"),
    FAKE_OPENSHELL_STATE: path.join(ctx.home, "openshell.json"),
    FAKE_CURSOR_LOG: path.join(ctx.home, "cursor.log"),
  });
  const runner = makeRunner(ctx, cursorAdapter({ env: ctx.env }));
  try {
    execFileSync("git", ["init", "--quiet", "--template=", ctx.root], { env: ctx.env });
    execFileSync("git", ["-C", ctx.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "commit", "--quiet", "--allow-empty", "-m", "Initial commit"], { env: ctx.env });
    await runner.boot();
    const started = await runner.start({ project: "demo", harness: "cursor", place: "openshell", prompt: "offline smoke" });
    assert.equal(runner.get(started.session).permissionMode, "full-access");
    await until(() => rows(fake).some((row) => row.type === "stop"), "Cursor stop row");
    assert.ok(rows(fake).some((row) => row.output === "echo: offline smoke"));
    const launch = readFileSync(ctx.env.FAKE_CURSOR_LOG, "utf8").trim().split("\n").map(JSON.parse)
      .find((entry) => entry.kind === "argv");
    assert.deepEqual(launch?.args, ["acp", "--force"]);
    assert.equal(launch.owned, "cursor");
    // The sandbox is the boundary, so an OpenShell session keeps approvals off: a mode change is refused.
    await assert.rejects(runner.setMode(started.session, "supervised"), /full access/);
    assert.deepEqual(await runner.close(started.session), { status: "ended" });
    assert.deepEqual(JSON.parse(readFileSync(ctx.env.FAKE_OPENSHELL_STATE, "utf8")).sandboxes, []);
  } finally {
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
  const emptyAdapters = mkdtempSync(path.join(os.tmpdir(), "no-adapters-"));
  const child = spawn(process.execPath, [path.join(ROOT, "runner", "main.mjs")], { env: { ...ctx.env, AI_COLLAB_RUNNER_SOCKET: socket, AI_COLLAB_RUNNER_DB: ctx.db, AI_COLLAB_RUNNER_ADAPTER_DIR: emptyAdapters } });
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

test("the control socket saves and publishes only accepted Claude model switches", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const adapter = wrapOpen(createFakeAdapter({ harness: "claude" }), async (options, context, open) => ({
    ...(await open(options, context)),
    async setModel(model) {
      if (model === "haiku") throw new Error("SDK rejected model");
    },
  }));
  const runner = makeRunner(ctx, adapter);
  await runner.boot();
  const socket = path.join(ctx.home, "run", "runner.sock");
  const control = await listenControl(runner, socket);
  try {
    const { session, nativeId } = await runner.start({ project: "demo", harness: "claude", prompt: "hi", model: "opus" });
    const client = runnerClient({ socket });
    await until(() => rows(fake).some(row => row.type === "stop"), "stop row");
    assert.equal((await client.setModel(session, "haiku")).status, 500);
    assert.equal(readOwned(ctx.cfg, sessionLabel(nativeId)).model, "opus");
    assert.equal((await client.setModel(session, "sonnet")).body.model, "sonnet");
    assert.equal(readOwned(ctx.cfg, sessionLabel(nativeId)).model, "sonnet");
    await runner.settle();
    assert.deepEqual(rows(fake).filter(row => row.type === "model").map(row => row.modelSwitch), [
      { from: "opus", to: "sonnet" },
    ]);
  } finally {
    await control.close();
    await runner.stop();
    await fake.close();
  }
});

test("live Cursor OpenShell turn through the runner service", {
  skip: process.env.AI_COLLAB_LIVE_CURSOR_OPENSHELL !== "1",
}, async () => {
  const openshell = process.env.AI_COLLAB_OPENSHELL_BIN || "openshell";
  const cursor = process.env.AI_COLLAB_CURSOR_BIN || cursorBinary(process.env.PATH);
  for (const binary of [openshell, cursor]) {
    const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 0, binary + " --version: " + (result.error?.message ?? result.stderr));
  }
  const project = "c" + randomBytes(4).toString("hex");
  const sandboxExists = () => JSON.parse(execFileSync(openshell, ["sandbox", "list", "-o", "json"], {
    encoding: "utf8", timeout: 30_000,
  })).sandboxes.some((sandbox) => sandbox.name === sandboxName(project));
  assert.equal(sandboxExists(), false, "smoke-test sandbox already exists");

  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const socket = path.join(ctx.home, "runner.sock");
  const client = runnerClient({ socket, timeoutMs: 240_000 });
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AI_COLLAB_"))),
    ...ctx.env,
    HOME: os.homedir(),
    AI_COLLAB_PROJECT: project,
    AI_COLLAB_PEERS: "cursor,runner",
    AI_COLLAB_RUNNER_SOCKET: socket,
    AI_COLLAB_RUNNER_HARNESSES: "cursor",
    AI_COLLAB_CURSOR_BIN: cursor,
    AI_COLLAB_OPENSHELL_BIN: openshell,
  };
  for (const key of ["AI_COLLAB_OPENSHELL_POLICY", "AI_COLLAB_CURSOR_TREE"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  let service;
  let exited;
  let session;
  let stderr = "";
  try {
    writeFileSync(path.join(env.XDG_CONFIG_HOME, "ai-collab", "projects.json"), JSON.stringify([{ root: ctx.root, project }]));
    writeFileSync(path.join(ctx.root, "README.md"), "Temporary Cursor smoke test repository.\n");
    execFileSync("git", ["init", "--quiet", "--template=", ctx.root], { env });
    execFileSync("git", ["-C", ctx.root, "add", "README.md"], { env });
    execFileSync("git", ["-C", ctx.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "Initial commit"], { env });

    service = spawn(process.execPath, [path.join(ROOT, "runner", "main.mjs")], { env, stdio: ["ignore", "ignore", "pipe"] });
    exited = once(service, "close");
    service.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    await until(() => {
      assert.equal(service.exitCode, null, stderr);
      return stderr.includes("listening on " + socket + "; adapters cursor");
    }, "runner service readiness", 15_000);
    assert.equal((await client.health()).status, 200);

    const marker = "cursor-openshell-live.txt";
    const started = await client.start({
      project, harness: "cursor", place: "openshell",
      prompt: "Create " + marker + " in the current directory containing only cursor-openshell-ok. Then confirm completion in your reply.",
    });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    session = started.body.session;
    const record = await client.get(session);
    assert.equal(record.status, 200);
    assert.equal(record.body.permissionMode, "full-access");
    assert.equal(record.body.place, "openshell");
    assert.equal(sandboxExists(), true, "runner did not create the sandbox");

    const activity = () => envelopes(fake, "ai-collab-" + project + "--activity")
      .filter((row) => row.session === sessionLabel(record.body.nativeId));
    const stop = await until(() => activity().find((row) => row.type === "stop"), "Cursor turn completion", 120_000);
    assert.equal(stop.input, "turn ended", JSON.stringify(activity()));
    assert.ok(activity().some((row) => row.type === "text" && row.tool !== "Notification" && row.output?.trim()));

    const closed = await client.close(session);
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.status, "ended");
    session = undefined;
    assert.equal(readFileSync(path.join(record.body.cwd, marker), "utf8").trim(), "cursor-openshell-ok");
    assert.equal(sandboxExists(), false, "runner did not delete the sandbox");
  } catch (error) {
    throw new Error("Live Cursor smoke test failed: " + error.message + "\n" + stderr, { cause: error });
  } finally {
    try {
      if (session) await client.close(session);
    } finally {
      if (service) {
        service.kill("SIGTERM");
        const kill = setTimeout(() => service.kill("SIGKILL"), 15_000);
        await exited.finally(() => clearTimeout(kill));
      }
      await fake.close();
      rmSync(ctx.home, { recursive: true, force: true });
    }
  }
});

test("a stopped Codex builder can hand dirty work to Claude after a failed launch", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const tasks = openTasks("demo", ctx.env);
  const paths = builderPaths("handoff", ctx.env);
  const git = (...args) => execFileSync("git", args, { cwd: ctx.root, stdio: "pipe" });
  git("init", "-b", "main");
  writeFileSync(path.join(ctx.root, "draft.txt"), "original\n");
  git("add", "draft.txt");
  git("-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "-m", "Initial");
  git("worktree", "add", "-b", "builder/handoff", paths.worktree);
  const draft = path.join(paths.worktree, "draft.txt");
  writeFileSync(draft, "unfinished edit\n");
  const owner = "codex#0123456789abcdef";
  await tasks.add({ id: "handoff", title: "Finish draft", detail: "Keep the draft concise", owner, status: "blocked" });
  await tasks.update("handoff", { owner });
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.state, JSON.stringify({
    id: "handoff", project: "demo", task: "handoff", harness: "codex", address: owner,
    phase: "stopped", branch: "builder/handoff", worktree: paths.worktree,
    oncebitten: 1, checkText: "Draft check fired",
  }));
  const claude = createFakeAdapter({ harness: "claude" });
  let failOpen = true;
  const adapter = wrapOpen(claude, async (options, context, open) => {
    assert.equal(options.cwd, paths.worktree);
    assert.equal(readFileSync(draft, "utf8"), "unfinished edit\n");
    assert.equal(tasks.get("handoff").owner, owner);
    if (failOpen) throw new Error("launch failed");
    return open(options, context);
  });
  const runner = makeRunner(ctx, adapter);
  await runner.boot();
  const socket = path.join(ctx.home, "runner.sock");
  const control = await listenControl(runner, socket);
  try {
    const client = runnerClient({ socket });
    const input = { project: "demo", taskId: "handoff", harness: "claude" };
    const before = tasks.get("handoff");
    assert.equal((await client.continueBuilder(input)).status, 502);
    assert.deepEqual(tasks.get("handoff"), before);
    assert.equal(readFileSync(draft, "utf8"), "unfinished edit\n");
    failOpen = false;
    const result = await client.continueBuilder(input);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(tasks.get("handoff").owner, result.body.session);
    assert.equal(tasks.get("handoff").status, "building");
    assert.equal((await client.continueBuilder({ ...input, harness: "codex" })).status, 409);
    const prompt = await until(() => claude.calls.find(call => call.op === "send")?.text, "replacement prompt");
    assert.match(prompt, /codex#0123456789abcdef/);
    assert.match(prompt, /exit 1 Draft check fired/);
    assert.match(prompt, /Keep the draft concise/);
  } finally {
    await control.close();
    await runner.stop();
    await fake.close();
    rmSync(ctx.home, { recursive: true, force: true });
  }
});
