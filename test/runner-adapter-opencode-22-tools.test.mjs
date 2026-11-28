// OpenCode 2.2 tool events: the call id is `id` and the name arrives on session.tool.input.started (captured from v2.2.5).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventType } from "@ag-ui/core";
import { eventProblem } from "../runner/contract.ts";
import { createOpenCodeAdapter } from "../runner/adapters/opencode.ts";
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

test("opencode 2.2 tool events key calls by id and take the name from input.started", async () => {
  const svc = await fakeService();
  const adapter = createOpenCodeAdapter({ env: svc.env, retryMs: 20 });
  try {
    const ctx = fakeCtx();
    const handle = await adapter.open({ cwd: "/work", permission: { autoReply: [], reply: "once" } }, ctx);
    await until(() => svc.streams.length, "event stream");
    await handle.send({ text: "list" });
    svc.emit({ type: "session.execution.started", data: { sessionID: SID } });
    svc.emit({ type: "session.tool.input.started", data: { sessionID: SID, assistantMessageID: "msg_1", id: "call_a", name: "shell" } });
    svc.emit({ type: "session.tool.input.ended", data: { sessionID: SID, assistantMessageID: "msg_1", id: "call_a", text: "{\"command\":\"ls\"}" } });
    svc.emit({ type: "session.tool.called", data: { sessionID: SID, assistantMessageID: "msg_1", id: "call_a", input: { command: "ls" }, executed: false } });
    svc.emit({ type: "session.tool.success", data: { sessionID: SID, assistantMessageID: "msg_1", id: "call_a", content: [{ type: "text", text: "a.txt" }] } });
    await until(() => ofType(ctx, EventType.TOOL_CALL_RESULT).length === 1, "tool result");
    const [chunk] = ofType(ctx, EventType.TOOL_CALL_CHUNK);
    assert.deepEqual([chunk.toolCallId, chunk.toolCallName, JSON.parse(chunk.delta)], ["call_a", "shell", { command: "ls" }]);
    const [result] = ofType(ctx, EventType.TOOL_CALL_RESULT);
    assert.deepEqual([result.toolCallId, result.messageId, result.metadata.aiCollab], ["call_a", "call_a:result", { toolCallName: "shell", failed: false }]);
    for (const e of ctx.events) assert.equal(eventProblem(e), null, e.type);
    await handle.close();
  } finally {
    await adapter.shutdown();
    await svc.close();
  }
});
