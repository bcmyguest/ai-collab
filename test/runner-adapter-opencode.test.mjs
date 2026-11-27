import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventType } from "@ag-ui/core";
import { eventProblem } from "../runner/contract.ts";
import { createOpenCodeAdapter, modelRef, sseData } from "../runner/adapters/opencode.ts";
import { tempDir } from "./helpers/tmp.mjs";

const PASSWORD = "test-password";
const AUTH = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`;
const SID = "ses_test";
const APPROVAL_REQUESTED_NAME = "ai-collab.approval-requested";

async function until(check, what, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// A loopback OpenCode service: scripted REST answers, a recorded call log, and an SSE stream the test writes to.
async function fakeService() {
  const state = tempDir({ after }, "ai-collab-opencode-svc-");
  const calls = [];
  const streams = [];
  const permissions = new Map();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method, path: req.url, body, auth: req.headers.authorization });
    const send = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== AUTH) return send(401, { error: "unauthorized" });
    if (req.method === "GET" && req.url === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      streams.push(res);
      res.on("close", () => { const at = streams.indexOf(res); if (at >= 0) streams.splice(at, 1); });
      return;
    }
    const session = /^\/api\/session\/([^/]+)(\/.*)?$/.exec(req.url);
    if (req.method === "POST" && req.url === "/api/session") return send(200, { data: { id: SID } });
    if (req.method === "GET" && req.url === "/api/info") return send(200, { version: "2.2.6" });
    if (req.method === "GET" && req.url === "/api/model") return send(200, { data: [{ providerID: "anthropic", id: "claude-x", name: "Claude X" }] });
    if (req.method === "GET" && req.url === "/api/command") return send(200, { data: [{ name: "review", description: "Review" }] });
    if (session && session[1] === "ses_gone") return send(404, { error: "no session" });
    if (session && session[2] === "/permission" && req.method === "GET") return send(200, { data: permissions.get(session[1]) ?? [] });
    if (session && session[2] === "/prompt") return send(200, { data: { id: "msg_1" } });
    if (session && session[2] === "/interrupt") return send(200, { interrupted: true });
    if (session && session[2] === "/compact") return send(200, { compacted: true });
    if (session && /^\/permission\/[^/]+\/reply$/.test(session[2] ?? "")) return send(200, {});
    if (session && session[2] === undefined && req.method === "GET") return send(200, { data: { id: session[1] } });
    return send(404, { error: "unscripted route" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  mkdirSync(path.join(state, "opencode"), { recursive: true });
  writeFileSync(path.join(state, "opencode", "service.json"), JSON.stringify({ url, password: PASSWORD }));
  const env = { XDG_STATE_HOME: state, PATH: process.env.PATH };
  return {
    env, streams, calls, permissions,
    emit(event) { for (const res of streams) res.write(`data: ${JSON.stringify(event)}\n\n`); },
    posts(p) { return calls.filter((c) => c.method === "POST" && c.path.startsWith(p)); },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(state, { recursive: true, force: true });
    },
  };
}

function fakeCtx() {
  const events = [];
  return { events, emit: (e) => events.push(e), log: () => {}, signal: new AbortController().signal };
}

const ofType = (ctx, type) => ctx.events.filter((e) => e.type === type);
const approvals = (ctx, name) => ctx.events.filter((e) => e.type === EventType.CUSTOM && e.name === name);

test("opencode modelRef splits provider from model and rejects a bare name", () => {
  assert.deepEqual(modelRef("anthropic/claude-x"), { providerID: "anthropic", modelID: "claude-x" });
  assert.deepEqual(modelRef("openrouter/meta/llama-4"), { providerID: "openrouter", modelID: "meta/llama-4" });
  assert.equal(modelRef("claude-x"), undefined);
  assert.equal(modelRef(undefined), undefined);
});

test("opencode sseData yields one payload per event across split chunks", async () => {
  async function* chunks() {
    yield Buffer.from(': ping\n\ndata: {"a"');
    yield Buffer.from(':1}\n\r\ndata: x\ndata: y\n\n');
  }
  const out = [];
  for await (const data of sseData(chunks())) out.push(data);
  assert.deepEqual(out, ['{"a":1}', "x\ny"]);
});

test("opencode available reports a missing service without a request, then a reachable one", async () => {
  const svc = await fakeService();
  try {
    const adapter = createOpenCodeAdapter({ env: { XDG_STATE_HOME: path.join(os.tmpdir(), "ai-collab-no-such-state") } });
    assert.equal((await adapter.available()).ok, false);
    const live = createOpenCodeAdapter({ env: svc.env });
    assert.deepEqual(await live.available(), { ok: true });
    assert.equal(svc.calls.every((c) => c.auth === AUTH), true, "every request carries the service password");
    await live.shutdown();
  } finally {
    await svc.close();
  }
});

test("opencode open creates a session; send starts a run that streams AG-UI events", async () => {
  const svc = await fakeService();
  const adapter = createOpenCodeAdapter({ env: svc.env, retryMs: 20 });
  try {
    const ctx = fakeCtx();
    const handle = await adapter.open({ cwd: "/work", model: "anthropic/claude-x", permission: { autoReply: [], reply: "once" } }, ctx);
    assert.equal(handle.nativeId, SID);
    assert.deepEqual(svc.posts("/api/session")[0].body, { location: { directory: "/work" }, model: { providerID: "anthropic", modelID: "claude-x" } });
    await until(() => svc.streams.length, "event stream");

    const { runId } = await handle.send({ text: "hello" });
    assert.deepEqual(svc.posts(`/api/session/${SID}/prompt`)[0].body, { text: "hello", delivery: "queue", resume: true });
    await assert.rejects(handle.send({ text: "again" }), /already running/);

    svc.emit({ type: "session.execution.started", data: { sessionID: SID } });
    await until(() => ofType(ctx, EventType.RUN_STARTED).length, "RUN_STARTED");
    svc.emit({ type: "session.text.ended", data: { sessionID: SID, assistantMessageID: "msg_a", ordinal: 1, text: "hi there" } });
    svc.emit({ type: "session.execution.succeeded", data: { sessionID: SID } });
    await until(() => ofType(ctx, EventType.RUN_FINISHED).length, "RUN_FINISHED");

    const started = ofType(ctx, EventType.RUN_STARTED)[0];
    assert.equal(started.runId, runId);
    assert.equal(started.input.messages[0].content, "hello");
    assert.deepEqual(ofType(ctx, EventType.TEXT_MESSAGE_CHUNK)[0], { type: EventType.TEXT_MESSAGE_CHUNK, messageId: "msg_a", role: "assistant", delta: "hi there" });
    assert.deepEqual(ofType(ctx, EventType.RUN_FINISHED)[0].outcome, { type: "success" });
    assert.equal(ofType(ctx, EventType.RUN_FINISHED)[0].runId, runId);
    for (const e of ctx.events) assert.equal(eventProblem(e), null, e.type);
    await handle.close();
  } finally {
    await adapter.shutdown();
    await svc.close();
  }
});

test("opencode interrupt ends the run once as cancelled, even when the execution event follows", async () => {
  const svc = await fakeService();
  const adapter = createOpenCodeAdapter({ env: svc.env, retryMs: 20 });
  try {
    const ctx = fakeCtx();
    const handle = await adapter.open({ cwd: "/work", permission: { autoReply: [], reply: "once" } }, ctx);
    await until(() => svc.streams.length, "event stream");
    const { runId } = await handle.send({ text: "long task" });
    svc.emit({ type: "session.execution.started", data: { sessionID: SID } });
    await until(() => ofType(ctx, EventType.RUN_STARTED).length, "RUN_STARTED");
    await handle.interrupt();
    svc.emit({ type: "session.execution.interrupted", data: { sessionID: SID, reason: "user" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const finished = ofType(ctx, EventType.RUN_FINISHED);
    assert.equal(finished.length, 1);
    assert.deepEqual([finished[0].runId, finished[0].outcome], [runId, { type: "cancelled" }]);
    assert.equal(svc.posts(`/api/session/${SID}/interrupt`).length, 1);
    await handle.close();
  } finally {
    await adapter.shutdown();
    await svc.close();
  }
});

test("opencode compact posts session.compact and refuses while a run is open", async () => {
  const svc = await fakeService();
  const adapter = createOpenCodeAdapter({ env: svc.env, retryMs: 20 });
  try {
    const ctx = fakeCtx();
    const handle = await adapter.open({ cwd: "/work", permission: { autoReply: [], reply: "once" } }, ctx);
    await until(() => svc.streams.length, "event stream");
    assert.equal(typeof handle.compact, "function");
    assert.deepEqual(await handle.compact(), {});
    assert.deepEqual(svc.posts(`/api/session/${SID}/compact`)[0].body, {});

    await handle.send({ text: "long task" });
    svc.emit({ type: "session.execution.started", data: { sessionID: SID } });
    await until(() => ofType(ctx, EventType.RUN_STARTED).length, "RUN_STARTED");
    await assert.rejects(() => handle.compact(), /finish the running turn/);
    assert.equal(svc.posts(`/api/session/${SID}/compact`).length, 1, "no second compact while mid-turn");
    await handle.interrupt();
    await handle.close();
  } finally {
    await adapter.shutdown();
    await svc.close();
  }
});

test("opencode permission asks become approval cards; allow replies once, deny replies reject, never always", async () => {
  const svc = await fakeService();
  const adapter = createOpenCodeAdapter({ env: svc.env, retryMs: 20 });
  try {
    const ctx = fakeCtx();
    const handle = await adapter.open({ cwd: "/work", permission: { autoReply: [], reply: "once" } }, ctx);
    await until(() => svc.streams.length, "event stream");
    svc.emit({ type: "permission.asked", data: { id: "per_1", sessionID: SID, action: "bash", resources: ["ls"], message: "run ls?" } });
    const card = await until(() => approvals(ctx, APPROVAL_REQUESTED_NAME)[0], "approval card");
    assert.deepEqual(card.value, { interruptId: "per_1", reason: "tool_approval", toolCallName: "bash", summary: "run ls?" });
    assert.equal(eventProblem(card), null);
    await handle.respond("per_1", { behavior: "allow" });
    assert.deepEqual(svc.posts(`/api/session/${SID}/permission/per_1/reply`)[0].body, { decision: "once" });

    svc.emit({ type: "permission.asked", data: { id: "per_2", sessionID: SID, action: "edit", resources: ["a.txt"] } });
    await until(() => approvals(ctx, APPROVAL_REQUESTED_NAME).length === 2, "second card");
    await handle.respond("per_2", { behavior: "deny", message: "no" });
    assert.deepEqual(svc.posts(`/api/session/${SID}/permission/per_2/reply`)[0].body, { decision: "reject", message: "no" });

    assert.equal(svc.calls.some((c) => JSON.stringify(c.body ?? {}).includes("always")), false, "no always grant");
    await assert.rejects(handle.respond("per_9", { behavior: "allow" }), /no open OpenCode approval/);
    await handle.close();
  } finally {
    await adapter.shutdown();
    await svc.close();
  }
});

test("opencode accept-edits auto-replies once to edit asks and surfaces the rest", async () => {
  const svc = await fakeService();
  const adapter = createOpenCodeAdapter({ env: svc.env, retryMs: 20 });
  try {
    const ctx = fakeCtx();
    await adapter.open({ cwd: "/work", permission: { autoReply: ["edit"], reply: "once" } }, ctx);
    await until(() => svc.streams.length, "event stream");
    svc.emit({ type: "permission.asked", data: { id: "per_e", sessionID: SID, action: "edit", resources: ["a.txt"] } });
    await until(() => svc.posts(`/api/session/${SID}/permission/per_e/reply`).length, "auto-reply");
    assert.deepEqual(svc.posts(`/api/session/${SID}/permission/per_e/reply`)[0].body, { decision: "once" });
    svc.emit({ type: "permission.asked", data: { id: "per_b", sessionID: SID, action: "bash", resources: ["rm"] } });
    await until(() => approvals(ctx, APPROVAL_REQUESTED_NAME)[0], "card for bash");
    assert.equal(approvals(ctx, APPROVAL_REQUESTED_NAME)[0].value.interruptId, "per_b");
    assert.equal(approvals(ctx, APPROVAL_REQUESTED_NAME).length, 1, "the edit ask left no card");
  } finally {
    await adapter.shutdown();
    await svc.close();
  }
});

test("opencode setPermissionMode changes the auto-reply set; an unknown mode is refused", async () => {
  const svc = await fakeService();
  const adapter = createOpenCodeAdapter({ env: svc.env, retryMs: 20 });
  try {
    const ctx = fakeCtx();
    const handle = await adapter.open({ cwd: "/work", permission: { autoReply: [], reply: "once" } }, ctx);
    await until(() => svc.streams.length, "event stream");
    await handle.setPermissionMode("full-access");
    svc.emit({ type: "permission.asked", data: { id: "per_f", sessionID: SID, action: "bash", resources: ["ls"] } });
    await until(() => svc.posts(`/api/session/${SID}/permission/per_f/reply`).length, "auto-reply under full-access");
    assert.equal(approvals(ctx, APPROVAL_REQUESTED_NAME).length, 0);
    await assert.rejects(handle.setPermissionMode("auto"), /no permission mode auto/);
    await handle.close();
  } finally {
    await adapter.shutdown();
    await svc.close();
  }
});

test("opencode maps tool calls and their results to TOOL_CALL events", async () => {
  const svc = await fakeService();
  const adapter = createOpenCodeAdapter({ env: svc.env, retryMs: 20 });
  try {
    const ctx = fakeCtx();
    const handle = await adapter.open({ cwd: "/work", permission: { autoReply: [], reply: "once" } }, ctx);
    await until(() => svc.streams.length, "event stream");
    const { runId } = await handle.send({ text: "list" });
    svc.emit({ type: "session.execution.started", data: { sessionID: SID } });
    svc.emit({ type: "session.tool.called", data: { sessionID: SID, callID: "call_1", name: "bash", input: { command: "ls" } } });
    svc.emit({ type: "session.tool.success", data: { sessionID: SID, callID: "call_1", content: "a.txt" } });
    svc.emit({ type: "session.tool.called", data: { sessionID: SID, callID: "call_2", name: "bash", input: { command: "rm" } } });
    svc.emit({ type: "session.tool.failed", data: { sessionID: SID, callID: "call_2", error: { message: "denied" } } });
    await until(() => ofType(ctx, EventType.TOOL_CALL_RESULT).length === 2, "tool results");
    const [chunk] = ofType(ctx, EventType.TOOL_CALL_CHUNK);
    assert.deepEqual([chunk.toolCallId, chunk.toolCallName, JSON.parse(chunk.delta)], ["call_1", "bash", { command: "ls" }]);
    const [ok, failed] = ofType(ctx, EventType.TOOL_CALL_RESULT);
    assert.deepEqual([ok.toolCallId, ok.messageId, ok.content, ok.metadata.aiCollab], ["call_1", "call_1:result", "a.txt", { toolCallName: "bash", failed: false }]);
    assert.deepEqual([failed.content, failed.metadata.aiCollab.failed], ["denied", true]);
    for (const e of ctx.events) assert.equal(eventProblem(e), null, e.type);
    svc.emit({ type: "session.execution.succeeded", data: { sessionID: SID } });
    await until(() => ofType(ctx, EventType.RUN_FINISHED).length, "RUN_FINISHED");
    assert.equal(ofType(ctx, EventType.RUN_FINISHED)[0].runId, runId);
    await handle.close();
  } finally {
    await adapter.shutdown();
    await svc.close();
  }
});

test("opencode execution failure ends the run with RUN_ERROR carrying its run id", async () => {
  const svc = await fakeService();
  const adapter = createOpenCodeAdapter({ env: svc.env, retryMs: 20 });
  try {
    const ctx = fakeCtx();
    const handle = await adapter.open({ cwd: "/work", permission: { autoReply: [], reply: "once" } }, ctx);
    await until(() => svc.streams.length, "event stream");
    const { runId } = await handle.send({ text: "break" });
    svc.emit({ type: "session.execution.failed", data: { sessionID: SID, error: { message: "provider quota" } } });
    await until(() => ofType(ctx, EventType.RUN_ERROR).length, "RUN_ERROR");
    const error = ofType(ctx, EventType.RUN_ERROR)[0];
    assert.equal(error.message, "provider quota");
    assert.equal(error.metadata.aiCollab.runId, runId);
    assert.equal(eventProblem(error), null);
    await handle.close();
  } finally {
    await adapter.shutdown();
    await svc.close();
  }
});

test("opencode emits no run events for executions this handle did not start", async () => {
  const svc = await fakeService();
  const adapter = createOpenCodeAdapter({ env: svc.env, retryMs: 20 });
  try {
    const ctx = fakeCtx();
    const handle = await adapter.open({ cwd: "/work", permission: { autoReply: [], reply: "once" } }, ctx);
    await until(() => svc.streams.length, "event stream");
    svc.emit({ type: "session.execution.started", data: { sessionID: SID } });
    svc.emit({ type: "session.text.ended", data: { sessionID: SID, assistantMessageID: "msg_x", ordinal: 1, text: "stray" } });
    svc.emit({ type: "session.execution.succeeded", data: { sessionID: SID } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(ctx.events, []);
    await handle.close();
  } finally {
    await adapter.shutdown();
    await svc.close();
  }
});

test("opencode resume reattaches by native id and surfaces the pending permissions", async () => {
  const svc = await fakeService();
  const adapter = createOpenCodeAdapter({ env: svc.env, retryMs: 20 });
  try {
    svc.permissions.set("ses_r", [{ id: "per_p", sessionID: "ses_r", action: "bash", resources: ["rm"], message: "delete?" }]);
    const ctx = fakeCtx();
    const record = { v: 1, nativeId: "ses_r", permissionMode: "supervised" };
    const handle = await adapter.resume(record, ctx, svc.env);
    assert.equal(handle.nativeId, "ses_r");
    const card = await until(() => approvals(ctx, APPROVAL_REQUESTED_NAME)[0], "resumed card");
    assert.equal(card.value.interruptId, "per_p");
    await handle.close();
    await assert.rejects(adapter.resume({ ...record, nativeId: "ses_gone" }, ctx, svc.env), /404/);
  } finally {
    await adapter.shutdown();
    await svc.close();
  }
});

test("opencode reconnects the event stream and surfaces asks that arrived during the gap", async () => {
  const svc = await fakeService();
  const adapter = createOpenCodeAdapter({ env: svc.env, retryMs: 20 });
  try {
    const ctx = fakeCtx();
    await adapter.open({ cwd: "/work", permission: { autoReply: [], reply: "once" } }, ctx);
    await until(() => svc.streams.length, "first stream");
    svc.permissions.set(SID, [{ id: "per_late", sessionID: SID, action: "bash", resources: ["ls"] }]);
    svc.streams[0].destroy();
    await until(() => approvals(ctx, APPROVAL_REQUESTED_NAME)[0], "card after reconnect");
    assert.equal(approvals(ctx, APPROVAL_REQUESTED_NAME)[0].value.interruptId, "per_late");
    assert.equal(svc.calls.filter((c) => c.path === `/api/session/${SID}/permission`).length >= 2, true, "pending list read on each connect");
  } finally {
    await adapter.shutdown();
    await svc.close();
  }
});

test("opencode lists models as provider/model and commands by name", async () => {
  const svc = await fakeService();
  const adapter = createOpenCodeAdapter({ env: svc.env, retryMs: 20 });
  try {
    assert.deepEqual(await adapter.listModels(), [{ id: "anthropic/claude-x" }]);
    assert.deepEqual(await adapter.listCommands("/work"), [{ name: "review", description: "Review" }]);
  } finally {
    await adapter.shutdown();
    await svc.close();
  }
});

test("opencode close drops the stream once no session is attached", async () => {
  const svc = await fakeService();
  const adapter = createOpenCodeAdapter({ env: svc.env, retryMs: 20 });
  try {
    const handle = await adapter.open({ cwd: "/work", permission: { autoReply: [], reply: "once" } }, fakeCtx());
    await until(() => svc.streams.length, "event stream");
    await handle.close();
    await until(() => svc.streams.length === 0, "stream dropped");
  } finally {
    await adapter.shutdown();
    await svc.close();
  }
});
