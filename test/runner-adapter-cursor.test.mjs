// Cursor adapter against a fake cursor-agent (ACP over stdio) and a fake openshell: no real CLI, account or sandbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventType } from "@ag-ui/core";
import cursorAdapter, { acpArgs, execArgv, sandboxName } from "../runner/adapters/cursor.mjs";
import { APPROVAL_REQUESTED, APPROVAL_RESOLVED, eventProblem } from "../runner/contract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CURSOR = path.join(HERE, "helpers", "fake-cursor-agent.mjs");
const OPENSHELL = path.join(HERE, "helpers", "fake-openshell.mjs");
chmodSync(CURSOR, 0o755);
chmodSync(OPENSHELL, 0o755);

function sandboxEnv(extra = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-cursor-"));
  const root = path.join(home, "demo");
  mkdirSync(root);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    AI_COLLAB_CURSOR_BIN: CURSOR,
    AI_COLLAB_OPENSHELL_BIN: OPENSHELL,
    FAKE_CURSOR_LOG: path.join(home, "cursor.log"),
    FAKE_OPENSHELL_LOG: path.join(home, "openshell.log"),
    FAKE_OPENSHELL_STATE: path.join(home, "openshell.json"),
    FAKE_SANDBOX_CURSOR_BIN: CURSOR,
    ...extra,
  };
  return { home, root, env };
}

function ctxFor(signal = new AbortController().signal) {
  const events = [];
  const logs = [];
  return { events, logs, emit: (e) => events.push(e), log: (m) => logs.push(m), signal };
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

const readLines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const cursorArgvs = (t) => readLines(t.env.FAKE_CURSOR_LOG).filter((e) => e.kind === "argv");
const finished = (ctx) => ctx.events.find((e) => e.type === EventType.RUN_FINISHED);
const optionsFor = (t, extra = {}) => ({
  project: "demo", cwd: t.root, permissionMode: "supervised", permission: { force: false }, place: "folder", env: t.env, ...extra,
});

test("sandboxName and acpArgs build the OpenShell name and the acp argv", () => {
  assert.equal(sandboxName("My_Project.v2"), "ai-collab-my-project-v2");
  assert.deepEqual(acpArgs(), ["acp"]);
  assert.deepEqual(acpArgs({ force: true }), ["acp", "--force"]);
  assert.deepEqual(acpArgs({ model: "composer-2.5" }), ["acp", "--model", "composer-2.5"]);
  assert.deepEqual(execArgv({ openshell: "openshell", sandbox: "s", args: ["acp", "--force"] }), [
    "openshell", "sandbox", "exec", "--no-tty", "-n", "s", "--env", "AI_COLLAB_OWNED=cursor", "--", "cursor-agent", "acp", "--force",
  ]);
});

test("available reports the CLI version, and a missing binary as not ok", async () => {
  const t = sandboxEnv();
  const adapter = cursorAdapter({ env: t.env });
  assert.equal(adapter.harness, "cursor");
  assert.deepEqual(adapter.capabilities.permissionModes, ["supervised", "full-access"]);
  const ok = await adapter.available(t.env);
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /fake/);
  const missing = await cursorAdapter({ env: { AI_COLLAB_CURSOR_BIN: "/nonexistent/cursor-agent" } }).available({});
  assert.equal(missing.ok, false);
});

test("a prompt streams text and every event passes the contract validator", async () => {
  const t = sandboxEnv();
  const adapter = cursorAdapter({ env: t.env });
  const ctx = ctxFor();
  const handle = await adapter.open(optionsFor(t), ctx);
  assert.equal(handle.nativeId, "fake-cursor-session");
  const { runId } = await handle.send({ text: "hello" });
  const done = await until(() => finished(ctx), "RUN_FINISHED");
  assert.deepEqual(done.outcome, { type: "success" });
  assert.equal(done.runId, runId);
  const text = ctx.events.find((e) => e.type === EventType.TEXT_MESSAGE_CHUNK);
  assert.equal(text.delta, "echo: hello");
  for (const e of ctx.events) assert.equal(eventProblem(e), null, `${e.type}: ${eventProblem(e)}`);
  const [argv] = cursorArgvs(t);
  assert.deepEqual(argv.args, ["acp"]);
  assert.equal(argv.cwd, t.root);
  assert.equal(argv.owned, "cursor");
  await handle.close();
  await adapter.shutdown();
});

test("an approve-allow decision reaches the agent as allow_once", async () => {
  const t = sandboxEnv();
  const adapter = cursorAdapter({ env: t.env });
  const ctx = ctxFor();
  const handle = await adapter.open(optionsFor(t), ctx);
  await handle.send({ text: "approve: ls" });
  const asked = await until(() => ctx.events.find((e) => e.name === APPROVAL_REQUESTED), "approval card");
  assert.equal(asked.value.reason, "tool_approval");
  assert.equal(asked.value.toolCallName, "Shell");
  assert.match(asked.value.summary, /ls/);
  await handle.respond(asked.value.interruptId, { behavior: "allow" });
  const resolved = await until(() => ctx.events.find((e) => e.name === APPROVAL_RESOLVED), "approval resolved");
  assert.deepEqual(resolved.value, { interruptId: asked.value.interruptId, status: "resolved", reason: "allowed" });
  await until(() => finished(ctx), "RUN_FINISHED");
  const decision = readLines(t.env.FAKE_CURSOR_LOG).find((e) => e.kind === "decision");
  assert.equal(decision.response.outcome.optionId, "allow-once");
  const result = ctx.events.find((e) => e.type === EventType.TOOL_CALL_RESULT);
  assert.equal(result.metadata.aiCollab.failed, false);
  for (const e of ctx.events) assert.equal(eventProblem(e), null, `${e.type}: ${eventProblem(e)}`);
  await handle.close();
});

test("an approval the operator denies reaches the agent as reject_once", async () => {
  const t = sandboxEnv();
  const adapter = cursorAdapter({ env: t.env });
  const ctx = ctxFor();
  const handle = await adapter.open(optionsFor(t), ctx);
  await handle.send({ text: "approve: rm -rf x" });
  const asked = await until(() => ctx.events.find((e) => e.name === APPROVAL_REQUESTED), "approval card");
  await handle.respond(asked.value.interruptId, { behavior: "deny" });
  const resolved = await until(() => ctx.events.find((e) => e.name === APPROVAL_RESOLVED), "approval resolved");
  assert.equal(resolved.value.reason, "denied");
  await until(() => finished(ctx), "RUN_FINISHED");
  const decision = readLines(t.env.FAKE_CURSOR_LOG).find((e) => e.kind === "decision");
  assert.equal(decision.response.outcome.optionId, "reject-once");
  assert.equal(ctx.events.find((e) => e.type === EventType.TOOL_CALL_RESULT).metadata.aiCollab.failed, true);
  await handle.close();
});

test("interrupt ends a hanging run as cancelled and cancels its open approval", async () => {
  const t = sandboxEnv();
  const adapter = cursorAdapter({ env: t.env });
  const ctx = ctxFor();
  const handle = await adapter.open(optionsFor(t), ctx);
  await handle.send({ text: "hang" });
  await until(() => ctx.events.find((e) => e.type === EventType.RUN_STARTED), "RUN_STARTED");
  await handle.interrupt();
  await until(() => finished(ctx), "RUN_FINISHED");
  assert.deepEqual(finished(ctx).outcome, { type: "cancelled" });
  await handle.close();
});

test("resume loads the native session by id and runs the next input", async () => {
  const t = sandboxEnv();
  const adapter = cursorAdapter({ env: t.env });
  const first = await adapter.open(optionsFor(t), ctxFor());
  await first.close();
  const ctx = ctxFor();
  const record = {
    v: 1, label: "x", address: "cursor#x", workflowId: "session-x", harness: "cursor", nativeId: "fake-cursor-session",
    project: "demo", cwd: t.root, place: "folder", permissionMode: "supervised", status: "idle", run: null, approvals: [],
    createdAt: 0, updatedAt: 0,
  };
  const handle = await adapter.resume(record, ctx, t.env);
  assert.equal(handle.nativeId, "fake-cursor-session");
  const load = readLines(t.env.FAKE_CURSOR_LOG).find((e) => e.kind === "rpc" && e.method === "session/load");
  assert.equal(load.params.sessionId, "fake-cursor-session");
  await handle.send({ text: "again" });
  await until(() => finished(ctx), "RUN_FINISHED");
  assert.equal(ctx.events.find((e) => e.type === EventType.TEXT_MESSAGE_CHUNK).delta, "echo: again");
  await handle.close();
});

test("full-access creates the project sandbox and runs acp --force inside it", async () => {
  const t = sandboxEnv();
  const adapter = cursorAdapter({ env: t.env });
  const ctx = ctxFor();
  const handle = await adapter.open(optionsFor(t, { place: "openshell", permissionMode: "full-access", permission: { force: true } }), ctx);
  const calls = readLines(t.env.FAKE_OPENSHELL_LOG);
  assert.deepEqual(calls[0], ["sandbox", "list", "-o", "json"]);
  assert.deepEqual(calls[1], ["sandbox", "create", "--name", "ai-collab-demo", "--no-tty", "--detach"]);
  const exec = calls.find((c) => c[1] === "exec");
  assert.deepEqual(exec.slice(0, 7), ["sandbox", "exec", "--no-tty", "-n", "ai-collab-demo", "--env", "AI_COLLAB_OWNED=cursor"]);
  assert.deepEqual(exec.slice(exec.indexOf("--") + 1), ["cursor-agent", "acp", "--force"]);
  assert.deepEqual(cursorArgvs(t).at(-1).args, ["acp", "--force"]);
  await handle.send({ text: "inside" });
  await until(() => finished(ctx), "RUN_FINISHED");
  assert.equal(ctx.events.find((e) => e.type === EventType.TEXT_MESSAGE_CHUNK).delta, "echo: inside");
  await handle.close();
});

test("a stopped sandbox is started, not created again", async () => {
  const t = sandboxEnv();
  writeFileSync(t.env.FAKE_OPENSHELL_STATE, JSON.stringify({ sandboxes: [{ name: "ai-collab-demo", phase: "stopped" }] }));
  const adapter = cursorAdapter({ env: t.env });
  const handle = await adapter.open(optionsFor(t, { place: "openshell", permissionMode: "full-access", permission: { force: true } }), ctxFor());
  const calls = readLines(t.env.FAKE_OPENSHELL_LOG);
  assert.ok(calls.some((c) => c.join(" ") === "sandbox start ai-collab-demo"));
  assert.ok(!calls.some((c) => c[1] === "create"));
  await handle.close();
});

test("full-access is refused outside openshell", async () => {
  const t = sandboxEnv();
  const adapter = cursorAdapter({ env: t.env });
  await assert.rejects(adapter.open(optionsFor(t, { permission: { force: true } }), ctxFor()), /only in openshell/);
  assert.equal(cursorArgvs(t).length, 0);
});

test("a session/new error reaches the caller", async () => {
  const t = sandboxEnv({ FAKE_CURSOR_NEW_ERROR: "not logged in: run cursor-agent login" });
  const adapter = cursorAdapter({ env: t.env });
  await assert.rejects(adapter.open(optionsFor(t), ctxFor()), /not logged in/);
});

test("listModels reads the --list-models lines", async () => {
  const t = sandboxEnv();
  const models = await cursorAdapter({ env: t.env }).listModels(t.env);
  assert.deepEqual(models, [{ id: "composer-2.5", label: "Composer 2.5" }, { id: "fake-1" }]);
  assert.deepEqual(await cursorAdapter({ env: t.env }).listCommands(t.root, t.env), []);
});
