import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeTraceRequest } from "../lib/analyze-otlp.mjs";
import { DEFAULT_OTLP_ENDPOINT, TRACE_ENV, exportSpans, hookTrace, otlpEndpoint, runRecorder, streamTrace } from "../lib/cursor-trace.ts";
import { sessionLabel } from "../lib/config.mjs";

const SESSION = "34b83f3e-25a5-4cdd-9cf8-f03ccb1c7f34";
// Lines a real `cursor-agent -p --output-format stream-json` run printed (2026.11.22-e9042b2), trimmed.
const STREAM = [
  { type: "system", subtype: "init", session_id: SESSION, model: "DeepSeek V4.1 Flash 1017 High" },
  { type: "tool_call", subtype: "started", call_id: "c1", tool_call: { shellToolCall: { args: { command: "echo hi" } } } },
  { type: "tool_call", subtype: "completed", call_id: "c1", tool_call: { shellToolCall: { args: { command: "echo hi" }, result: { success: { exitCode: 0 } } } } },
  { type: "tool_call", subtype: "started", call_id: "c2", tool_call: { readToolCall: { args: { path: "/x" } } } },
  { type: "tool_call", subtype: "completed", call_id: "c2", tool_call: { readToolCall: { args: { path: "/x" }, result: { error: { message: "nope" } } } } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "OK" }] } },
  { type: "result", subtype: "success", is_error: false, session_id: SESSION, usage: { inputTokens: 14875, outputTokens: 42, cacheReadTokens: 21760, cacheWriteTokens: 0 } },
].map((e) => JSON.stringify(e));

const byKind = (spans, kind) => spans.filter((s) => s.attrs["openinference.span.kind"] === kind);

function configEnv(defaults) {
  const home = mkdtempSync(path.join(os.tmpdir(), "cursor-trace-"));
  if (defaults) {
    mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
    writeFileSync(path.join(home, ".config", "ai-collab", "defaults.json"), JSON.stringify(defaults));
  }
  return { HOME: home, AI_COLLAB_STATE_DIR: path.join(home, "state") };
}

// A receiver that records each POST; `hang` never answers.
async function receiver({ hang = false } = {}) {
  const posts = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      posts.push({ url: req.url, type: req.headers["content-type"], body: Buffer.concat(chunks) });
      if (!hang) res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { posts, url: `http://127.0.0.1:${server.address().port}/v1/traces`, close: () => { server.closeAllConnections(); server.close(); } };
}

test("otlpEndpoint: default with a defaults.json, its otlpEndpoint, off, env override, none without config", () => {
  assert.equal(otlpEndpoint(configEnv({})), DEFAULT_OTLP_ENDPOINT);
  assert.equal(otlpEndpoint(configEnv({ otlpEndpoint: "http://h:1/v1/traces" })), "http://h:1/v1/traces");
  assert.equal(otlpEndpoint(configEnv({ otlpEndpoint: "off" })), "");
  assert.equal(otlpEndpoint(configEnv({ otlpEndpoint: false })), "");
  assert.equal(otlpEndpoint({ ...configEnv({}), AI_COLLAB_OTLP_ENDPOINT: "off" }), "");
  assert.equal(otlpEndpoint({ ...configEnv({ otlpEndpoint: "off" }), AI_COLLAB_OTLP_ENDPOINT: "http://e/v1/traces" }), "http://e/v1/traces");
  assert.equal(otlpEndpoint(configEnv(null)), "");
});

test("streamTrace: one trace with an agent root, an LLM span with model and tokens, a tool span per call", () => {
  let t = 1000;
  const trace = streamTrace({ role: "builder", model: "deepseek-v41-flash-1017-high", now: () => (t += 10) });
  for (const line of STREAM) trace.line(line);
  trace.line("not json");
  const spans = trace.spans();
  assert.equal(new Set(spans.map((s) => s.traceId)).size, 1);
  const [root] = byKind(spans, "AGENT");
  assert.equal(root.parentSpanId, undefined);
  assert.equal(root.attrs["session.id"], `cursor#${sessionLabel(SESSION)}`);
  assert.equal(root.attrs["ai_collab.role"], "builder");
  const [llm] = byKind(spans, "LLM");
  assert.equal(llm.parentSpanId, root.spanId);
  assert.equal(llm.attrs["llm.model_name"], "deepseek-v41-flash-1017-high");
  assert.equal(llm.attrs["llm.token_count.prompt"], 14875 + 21760);
  assert.equal(llm.attrs["llm.token_count.prompt_details.cache_read"], 21760);
  assert.equal(llm.attrs["llm.token_count.completion"], 42);
  assert.equal(llm.attrs["llm.token_count.total"], 14875 + 21760 + 42);
  const tools = byKind(spans, "TOOL");
  assert.deepEqual(tools.map((s) => s.attrs["tool.name"]), ["shell", "read"]);
  assert.ok(tools.every((s) => s.parentSpanId === root.spanId && s.endMs >= s.startMs));
  assert.equal(tools[1].attrs["ai_collab.failed"], true);
  assert.ok(spans.every((s) => s.endMs <= root.endMs && s.startMs >= root.startMs));
});

test("streamTrace: the init model names the run when none is given; no result means no token counts", () => {
  const trace = streamTrace({});
  trace.line(STREAM[0]);
  const [llm] = byKind(trace.spans(), "LLM");
  assert.equal(llm.attrs["llm.model_name"], "DeepSeek V4.1 Flash 1017 High");
  assert.equal(llm.attrs["llm.token_count.total"], undefined);
});

test("encodeTraceRequest writes the parent span id", () => {
  const body = encodeTraceRequest([{ traceId: "a".repeat(32), spanId: "b".repeat(16), parentSpanId: "c".repeat(16), name: "n", startMs: 1, endMs: 2 }]);
  assert.ok(body.includes(Buffer.from("c".repeat(16), "hex")));
});

test("exportSpans posts OTLP protobuf; an unreachable or hanging endpoint resolves false within the timeout", async () => {
  const ok = await receiver();
  const trace = streamTrace({});
  for (const line of STREAM) trace.line(line);
  assert.equal(await exportSpans(trace.spans(), { endpoint: ok.url }), true);
  ok.close();
  assert.equal(ok.posts[0].type, "application/x-protobuf");
  assert.ok(ok.posts[0].body.includes(Buffer.from("llm.token_count.total")));
  assert.equal(await exportSpans(trace.spans(), { endpoint: "http://127.0.0.1:1/v1/traces" }), false);
  const hang = await receiver({ hang: true });
  const started = Date.now();
  assert.equal(await exportSpans(trace.spans(), { endpoint: hang.url, timeoutMs: 200 }), false);
  assert.ok(Date.now() - started < 1500);
  hang.close();
  assert.equal(await exportSpans([], { endpoint: "" }), false);
});

test("hookTrace: sessionStart, tool calls, sessionEnd export one trace with model and tools", async () => {
  const sink = await receiver();
  const env = { ...configEnv({ otlpEndpoint: sink.url }), AI_COLLAB_TRACE_ROLE: "schedule:pm" };
  const base = { conversation_id: SESSION, session_id: SESSION, cursor_version: "2026.11.22-e9042b2" };
  let t = 5000;
  const now = () => (t += 100);
  await hookTrace({ ...base, hook_event_name: "sessionStart", model: "deepseek-v41-flash-1017-high" }, { env, now });
  const tool = { ...base, hook_event_name: "postToolUse", model: "deepseek-v41-flash-1017", tool_name: "Shell", tool_use_id: "u1", tool_input: { command: "echo hi" }, duration: 206.2 };
  await hookTrace(tool, { env, now });
  await hookTrace(tool, { env, now }); // a second registration of the same hook
  await hookTrace({ ...base, hook_event_name: "postToolUseFailure", tool_name: "Read", tool_use_id: "u2", tool_input: { path: "/x" } }, { env, now });
  assert.equal(sink.posts.length, 0);
  const spans = await hookTrace({ ...base, hook_event_name: "sessionEnd", duration_ms: 4488 }, { env, now });
  sink.close();
  assert.equal(sink.posts.length, 1);
  const [root] = byKind(spans, "AGENT");
  assert.equal(root.attrs["session.id"], `cursor#${sessionLabel(SESSION)}`);
  assert.equal(root.attrs["ai_collab.role"], "schedule:pm");
  assert.equal(byKind(spans, "LLM")[0].attrs["llm.model_name"], "deepseek-v41-flash-1017-high");
  const tools = byKind(spans, "TOOL");
  assert.deepEqual(tools.map((s) => s.attrs["tool.name"]), ["Shell", "Read"]);
  assert.equal(tools[1].attrs["ai_collab.failed"], true);
  assert.equal(readdirSync(path.join(env.AI_COLLAB_STATE_DIR, "cursor-traces")).length, 0);
});

test("hookTrace: a turn ends at stop; a sessionEnd after it exports nothing more", async () => {
  const sink = await receiver();
  const env = configEnv({ otlpEndpoint: sink.url });
  const base = { conversation_id: SESSION };
  await hookTrace({ ...base, hook_event_name: "beforeSubmitPrompt", model: "m" }, { env });
  await hookTrace({ ...base, hook_event_name: "stop" }, { env });
  assert.equal(await hookTrace({ ...base, hook_event_name: "sessionEnd" }, { env }), null);
  sink.close();
  assert.equal(sink.posts.length, 1);
});

test("hookTrace records nothing for a run its launcher traces, or with export off", async () => {
  for (const env of [{ ...configEnv({}), [TRACE_ENV]: "launcher" }, { ...configEnv({}), AI_COLLAB_OWNED: "cursor" }, configEnv({ otlpEndpoint: "off" })]) {
    assert.equal(await hookTrace({ conversation_id: SESSION, hook_event_name: "sessionStart" }, { env }), null);
    assert.equal(existsSync(path.join(env.AI_COLLAB_STATE_DIR, "cursor-traces")), false);
  }
});

test("runRecorder: an ACP run's tool calls, model and status; a call left open ends failed", () => {
  const rec = runRecorder({ address: "cursor#0123456789abcdef", role: "runner", model: "composer-2.5" });
  rec.toolStart("t1", "Read file", { path: "/a" });
  rec.toolEnd("t1", { failed: false });
  rec.toolStart("t2", "Shell", { command: "sleep 9" });
  const spans = rec.spans({ status: "cancelled" });
  const [root] = byKind(spans, "AGENT");
  assert.equal(root.attrs["ai_collab.status"], "cancelled");
  assert.equal(root.attrs["llm.model_name"], "composer-2.5");
  assert.deepEqual(byKind(spans, "TOOL").map((s) => [s.attrs["tool.name"], s.attrs["ai_collab.failed"] ?? false]), [["Read file", false], ["Shell", true]]);
});
