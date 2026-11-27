// Cursor ACP hardening against a fake agent over stdio: argv order, mcpServers, resume or load, model config, questions, allow-always.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventType } from "@ag-ui/core";
import cursorAdapter, { acpArgs, sessionMcpServers } from "../runner/adapters/cursor.mjs";
import { APPROVAL_REQUESTED, APPROVAL_RESOLVED, eventProblem } from "../runner/contract.ts";
import { permissionQuestion, selectPermissionOptionId } from "../lib/acp/permission.ts";
import { replyDecision } from "../lib/approvals.ts";
import { tempDir } from "./helpers/tmp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.join(HERE, "helpers", "fake-acp-agent.mjs");
chmodSync(AGENT, 0o755);

function setup(caps) {
  const home = tempDir({ after }, "ai-collab-acp-");
  const root = path.join(home, "demo");
  mkdirSync(root);
  const env = { PATH: process.env.PATH, HOME: home, AI_COLLAB_CURSOR_BIN: AGENT, FAKE_ACP_LOG: path.join(home, "acp.log"), AI_COLLAB_TOKEN: "secret", ...(caps ? { FAKE_ACP_CAPS: JSON.stringify(caps) } : {}) };
  return { home, root, env };
}

function ctxFor() {
  const events = [];
  const logs = [];
  return { events, logs, emit: (e) => events.push(e), log: (m) => logs.push(m), signal: new AbortController().signal };
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

const lines = (t) => (existsSync(t.env.FAKE_ACP_LOG) ? readFileSync(t.env.FAKE_ACP_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const rpcs = (t, method) => lines(t).filter((e) => e.kind === "rpc" && e.method === method);
const decisions = (t) => lines(t).filter((e) => e.kind === "decision").map((e) => e.response.outcome);
const options = (t, extra = {}) => ({ project: "demo", cwd: t.root, permissionMode: "supervised", permission: { force: false }, place: "folder", env: t.env, ...extra });
const record = (t, extra = {}) => ({
  v: 1, label: "abc", address: "cursor#abc", harness: "cursor", nativeId: "fake-acp-session", project: "demo", cwd: t.root, place: "folder",
  permissionMode: "supervised", status: "idle", run: null, approvals: [], ...extra,
});
const requests = (ctx) => ctx.events.filter((e) => e.name === APPROVAL_REQUESTED);
const finishedCount = (ctx) => ctx.events.filter((e) => e.type === EventType.RUN_FINISHED).length;

test("top-level flags come before the acp subcommand", async () => {
  assert.deepEqual(acpArgs({ force: true, model: "composer-2.5" }), ["--force", "--model", "composer-2.5", "acp"]);
  const t = setup();
  const adapter = cursorAdapter({ env: t.env });
  const handle = await adapter.open(options(t, { model: "composer-2.5" }), ctxFor());
  assert.deepEqual(lines(t).find((e) => e.kind === "argv").args, ["--model", "composer-2.5", "acp"]);
  await handle.close();
  await adapter.shutdown();
});

test("session/new and session/load send the bus MCP server and configured ones", async () => {
  const t = setup();
  const adapter = cursorAdapter({ env: t.env });
  const configured = { docs: { url: "http://127.0.0.1:9/mcp", headers: { A: "1" } }, legacy: { type: "sse", url: "http://127.0.0.1:9/sse" }, local: { command: "tool", args: ["--x"], env: { B: "2" } } };
  const handle = await adapter.open(options(t, { mcpServers: configured }), ctxFor());
  const [created] = rpcs(t, "session/new");
  const names = created.params.mcpServers.map((s) => s.name);
  // sse is dropped: the fake advertises mcpCapabilities.http only.
  assert.deepEqual(names, ["ai-collab", "docs", "local"]);
  const bus = created.params.mcpServers[0];
  assert.equal(bus.command, process.execPath);
  assert.match(bus.args[0], /scripts\/ai-collab-mcp\.mjs$/);
  assert.deepEqual(bus.args.slice(1), ["cursor"]);
  const env = Object.fromEntries(bus.env.map(({ name, value }) => [name, value]));
  assert.equal(env.AI_COLLAB_PEER, "cursor");
  assert.equal(env.AI_COLLAB_PROJECT, "demo");
  assert.equal(env.HOME, t.home);
  assert.equal(env.AI_COLLAB_TOKEN, undefined);
  assert.deepEqual(created.params.mcpServers[1], { type: "http", name: "docs", url: "http://127.0.0.1:9/mcp", headers: [{ name: "A", value: "1" }] });
  assert.deepEqual(created.params.mcpServers[2], { name: "local", command: "tool", args: ["--x"], env: [{ name: "B", value: "2" }] });
  const resume = handle.resumeData();
  await handle.close();
  const again = await adapter.resume(record(t, { resume }), ctxFor(), t.env);
  const [loaded] = rpcs(t, "session/load");
  assert.deepEqual(loaded.params.mcpServers, created.params.mcpServers);
  await again.close();
  await adapter.shutdown();
  assert.deepEqual(sessionMcpServers({ place: "openshell", configured: [{ name: "x", command: "y", args: [], env: [] }] }).map((s) => s.name), ["x"]);
});

test("resume uses session/resume when advertised, and never replays", async () => {
  const t = setup({ sessionCapabilities: { resume: {} } });
  const adapter = cursorAdapter({ env: t.env });
  const ctx = ctxFor();
  const handle = await adapter.resume(record(t), ctx, t.env);
  assert.equal(rpcs(t, "session/resume").length, 1);
  assert.equal(rpcs(t, "session/load").length, 0);
  assert.equal(rpcs(t, "session/resume")[0].params.sessionId, "fake-acp-session");
  await handle.close();
  await adapter.shutdown();
});

test("resume falls back to session/load, ignores the replay, and is idle for the next input", async () => {
  const t = setup();
  const adapter = cursorAdapter({ env: t.env });
  const ctx = ctxFor();
  const handle = await adapter.resume(record(t), ctx, t.env);
  assert.equal(rpcs(t, "session/load").length, 1);
  assert.equal(rpcs(t, "session/resume").length, 0);
  assert.deepEqual(ctx.events, []);
  await handle.send({ text: "next" });
  await until(() => finishedCount(ctx) === 1, "RUN_FINISHED");
  const text = ctx.events.filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK).map((e) => e.delta).join("");
  assert.equal(text, "echo: next");
  assert.equal(ctx.events.some((e) => e.type === EventType.TOOL_CALL_CHUNK), false);
  await handle.close();
  await adapter.shutdown();
});

test("setModel changes the model through session/set_config_option", async () => {
  const t = setup();
  const adapter = cursorAdapter({ env: t.env });
  const handle = await adapter.open(options(t), ctxFor());
  assert.deepEqual(handle.models(), { current: "composer-2.5", models: [{ id: "composer-2.5", label: "Composer 2.5" }, { id: "gpt-5", label: "GPT-5" }] });
  await handle.setModel("gpt-5");
  assert.deepEqual(rpcs(t, "session/set_config_option").map((e) => e.params), [{ sessionId: "fake-acp-session", configId: "model", value: "gpt-5" }]);
  assert.equal(rpcs(t, "session/set_model").length, 0);
  assert.equal(handle.models().current, "gpt-5");
  await assert.rejects(handle.setModel("nope"), /offers no model nope/);
  await handle.close();
  await adapter.shutdown();
});

test("an ask_question permission request becomes a question card and the answer picks its option", async () => {
  const t = setup();
  const adapter = cursorAdapter({ env: t.env });
  const ctx = ctxFor();
  const handle = await adapter.open(options(t), ctx);
  await handle.send({ text: "question" });
  const asked = await until(() => requests(ctx)[0], "question card");
  assert.equal(asked.value.reason, "question");
  assert.deepEqual(asked.value.questions, [{ question: "Which colour?", header: "Pick a colour", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }] }]);
  await handle.respond(asked.value.interruptId, { behavior: "allow", answers: { "Which colour?": "Blue" } });
  await until(() => finishedCount(ctx) === 1, "RUN_FINISHED");
  assert.deepEqual(decisions(t), [{ outcome: "selected", optionId: "blue" }]);
  assert.equal(ctx.events.find((e) => e.name === APPROVAL_RESOLVED).value.reason, "answered");
  for (const e of ctx.events) assert.equal(eventProblem(e), null, `${e.type}: ${eventProblem(e)}`);
  await handle.send({ text: "question" });
  const second = await until(() => requests(ctx)[1], "second question card");
  await handle.respond(second.value.interruptId, { behavior: "deny" });
  await until(() => finishedCount(ctx) === 2, "second RUN_FINISHED");
  assert.deepEqual(decisions(t)[1], { outcome: "selected", optionId: "__ask_question_skip__" });
  await handle.close();
  await adapter.shutdown();
});

test("allow for the session picks allow_always and the runner answers the same tool kind after that", async () => {
  const t = setup();
  const adapter = cursorAdapter({ env: t.env });
  const ctx = ctxFor();
  const handle = await adapter.open(options(t), ctx);
  await handle.send({ text: "tools 3" });
  const asked = await until(() => requests(ctx)[0], "approval card");
  assert.equal(asked.value.reason, "tool_approval");
  await handle.respond(asked.value.interruptId, { behavior: "allow", scope: "session" });
  await until(() => finishedCount(ctx) === 1, "RUN_FINISHED");
  assert.equal(requests(ctx).length, 1);
  assert.deepEqual(decisions(t).map((d) => d.optionId), ["allow-always", "allow-always", "allow-always"]);
  assert.equal(ctx.logs.filter((l) => /allowed Shell for this session/.test(l)).length, 2);
  await handle.close();
  await adapter.shutdown();
});

test("a plain allow is once: the next call of the same kind asks again", async () => {
  const t = setup();
  const adapter = cursorAdapter({ env: t.env });
  const ctx = ctxFor();
  const handle = await adapter.open(options(t), ctx);
  await handle.send({ text: "tools 2" });
  const first = await until(() => requests(ctx)[0], "approval card");
  await handle.respond(first.value.interruptId, { behavior: "allow" });
  const second = await until(() => requests(ctx)[1], "second approval card");
  await handle.respond(second.value.interruptId, { behavior: "allow" });
  await until(() => finishedCount(ctx) === 1, "RUN_FINISHED");
  assert.deepEqual(decisions(t).map((d) => d.optionId), ["allow-once", "allow-once"]);
  await handle.close();
  await adapter.shutdown();
});

test("selectPermissionOptionId falls back to allow_once, and plain approvals are not questions", () => {
  const once = { options: [{ optionId: "a", kind: "allow_once" }, { optionId: "r", kind: "reject_once" }] };
  assert.equal(selectPermissionOptionId(once, "acceptForSession"), "a");
  assert.equal(selectPermissionOptionId(once, "decline"), "r");
  assert.equal(permissionQuestion({ toolCall: { title: "Shell", kind: "execute" }, ...once }), null);
  assert.deepEqual(replyDecision({}, "always"), { behavior: "allow", scope: "session" });
});
