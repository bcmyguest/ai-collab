/**
 * OTLP traces for Cursor runs. Cursor's own OpenTelemetry exporter posts only to Cursor's backend (URL and bearer
 * token fixed in the CLI), so ai-collab builds the spans from what it sees: the stream-json output of a run it
 * launches (model, tool calls, token usage) or the Cursor hooks of any other run (model, tool calls; Cursor hands
 * hooks no token counts). One trace per run: an AGENT root, one LLM child, one TOOL child per tool call, with
 * OpenInference attributes. Export is best effort: one POST with a short timeout that never throws.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { encodeTraceRequest } from "./analyze-otlp.mjs";
import { autoDefaults, sessionLabel, stateDir } from "./config.mjs";

export const DEFAULT_OTLP_ENDPOINT = "http://localhost:6006/v1/traces";
export const EXPORT_TIMEOUT_MS = 1500;
// Set on a Cursor process whose launcher traces it from stream-json or ACP; its hooks then record nothing.
export const TRACE_ENV = "AI_COLLAB_CURSOR_TRACE";
// The ai_collab.role a hook-traced run reports (a schedule sets schedule:<name>).
export const ROLE_ENV = "AI_COLLAB_TRACE_ROLE";
const OFF = new Set(["", "off", "false", "0", "none"]);
const INPUT_MAX = 1000;
const HOOK_DIR = "cursor-traces";

/**
 * The OTLP/HTTP traces URL, or "" when export is off. AI_COLLAB_OTLP_ENDPOINT wins, then defaults.json "otlpEndpoint";
 * a machine with a defaults.json but no such key gets DEFAULT_OTLP_ENDPOINT. No defaults.json (an isolated test
 * HOME, a fresh install) means no export.
 */
export function otlpEndpoint(env = process.env) {
  const defaults = autoDefaults(env);
  const value = env.AI_COLLAB_OTLP_ENDPOINT ?? (defaults ? defaults.otlpEndpoint ?? DEFAULT_OTLP_ENDPOINT : "");
  return typeof value === "string" && !OFF.has(value.trim().toLowerCase()) ? value.trim() : "";
}

const newId = (bytes) => randomBytes(bytes).toString("hex");
const clip = (value) => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? {});
  return text.length > INPUT_MAX ? text.slice(0, INPUT_MAX) : text;
};

/**
 * The spans of one run. usage is {input, output, cacheRead, cacheWrite}; the prompt count includes cached tokens.
 * tools are [{name, startMs, endMs, input, failed}].
 */
export function runSpans({ address, role, model, startMs, endMs, usage, tools = [], status = "ok" }) {
  const traceId = newId(16);
  const rootId = newId(8);
  const shared = { "session.id": address, ...(role ? { "ai_collab.role": role } : {}) };
  const modelAttr = model ? { "llm.model_name": model } : {};
  const tokens = usage ? (() => {
    const prompt = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
    return {
      "llm.token_count.prompt": prompt, "llm.token_count.completion": usage.output || 0, "llm.token_count.total": prompt + (usage.output || 0),
      "llm.token_count.prompt_details.cache_read": usage.cacheRead || 0, "llm.token_count.prompt_details.cache_write": usage.cacheWrite || 0,
    };
  })() : {};
  return [
    {
      traceId, spanId: rootId, name: "cursor-agent run", startMs, endMs,
      attrs: { "openinference.span.kind": "AGENT", ...shared, ...modelAttr, "ai_collab.harness": "cursor", "ai_collab.status": status, "ai_collab.tool_calls": tools.length },
    },
    {
      traceId, spanId: newId(8), parentSpanId: rootId, name: "cursor llm", startMs, endMs,
      attrs: { "openinference.span.kind": "LLM", ...shared, ...modelAttr, "llm.provider": "cursor", ...tokens },
    },
    ...tools.map((tool) => ({
      traceId, spanId: newId(8), parentSpanId: rootId, name: `tool ${tool.name}`, startMs: tool.startMs, endMs: Math.max(tool.startMs, tool.endMs),
      attrs: { "openinference.span.kind": "TOOL", ...shared, "tool.name": tool.name, "input.value": clip(tool.input), ...(tool.failed ? { "ai_collab.failed": true } : {}) },
    })),
  ];
}

/** POSTs the spans as OTLP protobuf; resolves true on a 2xx, false on anything else. Never rejects. */
export async function exportSpans(spans, { endpoint, timeoutMs = EXPORT_TIMEOUT_MS, project = "ai-collab" } = {}) {
  if (!endpoint || !spans.length) return false;
  try {
    const res = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/x-protobuf" },
      body: encodeTraceRequest(spans, { project, service: "ai-collab-cursor", scope: "ai-collab.cursor-trace" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.arrayBuffer().catch(() => {});
    return res.ok;
  } catch {
    return false;
  }
}

// The tool name of a stream-json tool_call: its one key without "ToolCall" (shellToolCall -> shell), or an MCP tool's own name.
function streamTool(toolCall) {
  const key = Object.keys(toolCall ?? {})[0] ?? "tool";
  const body = toolCall?.[key] ?? {};
  const name = body.args?.toolName || body.args?.name;
  return { name: key === "mcpToolCall" && name ? `mcp ${name}` : key.replace(/ToolCall$/, "") || "tool", body };
}

/**
 * One run's recorder: tool calls by id, usage, status. spans() closes calls still open as failed. The runner's ACP
 * adapter drives it directly; streamTrace feeds it from stream-json.
 */
export function runRecorder({ address, role, model, now = Date.now } = {}) {
  const startMs = now();
  const open = new Map();
  const tools = [];
  const rec = {
    address, model, usage: null, status: "ok",
    toolStart(id, name, input) { open.set(id, { name, startMs: now(), input }); },
    toolEnd(id, { name, input, failed = false } = {}) {
      const started = open.get(id) ?? { name: name || "tool", startMs: now(), input };
      open.delete(id);
      tools.push({ ...started, endMs: now(), failed });
    },
    spans({ status } = {}) {
      const endMs = now();
      const unfinished = [...open.values()].map((tool) => ({ ...tool, endMs, failed: true }));
      return runSpans({ address: rec.address, role, model: rec.model, startMs, endMs, usage: rec.usage, tools: [...tools, ...unfinished], status: status ?? rec.status });
    },
  };
  return rec;
}

/**
 * A tracer fed the lines of `cursor-agent -p --output-format stream-json`. model is the --model the launcher passed
 * (the init event names only a display label); address defaults to cursor#<label of the run's session id>.
 */
export function streamTrace({ address, role, model, now = Date.now } = {}) {
  const rec = runRecorder({ address, role, model, now });
  let sessionId = "";
  let shownModel = "";
  return {
    line(text) {
      let event;
      try { event = JSON.parse(text); } catch { return; }
      if (!event || typeof event !== "object") return;
      if (typeof event.session_id === "string") sessionId ||= event.session_id;
      if (event.type === "system" && typeof event.model === "string") shownModel = event.model;
      if (event.type === "tool_call" && typeof event.call_id === "string") {
        const { name, body } = streamTool(event.tool_call);
        if (event.subtype === "started") rec.toolStart(event.call_id, name, body.args);
        if (event.subtype === "completed") rec.toolEnd(event.call_id, { name, input: body.args, failed: Boolean(body.result) && !body.result.success });
      }
      if (event.type === "result") {
        rec.status = event.is_error ? "error" : "ok";
        const u = event.usage;
        if (u && typeof u === "object") rec.usage = { input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadTokens, cacheWrite: u.cacheWriteTokens };
      }
    },
    spans({ exitStatus } = {}) {
      rec.address ||= `cursor#${sessionLabel(sessionId) || "unknown"}`;
      rec.model ||= shownModel;
      return rec.spans({ status: exitStatus });
    },
  };
}

/** Feeds a child's stdout through a streamTrace while passing it on to `out`; finish() exports the trace. */
export function traceStream(stream, { env = process.env, out, ...options }) {
  const trace = streamTrace(options);
  let rest = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    out?.write(chunk);
    rest += chunk;
    const lines = rest.split("\n");
    rest = lines.pop();
    for (const line of lines) trace.line(line);
  });
  return {
    finish({ exitStatus } = {}) {
      if (rest) trace.line(rest);
      rest = "";
      return exportSpans(trace.spans({ exitStatus }), { endpoint: otlpEndpoint(env) });
    },
  };
}

const START_EVENTS = new Set(["sessionstart", "beforesubmitprompt"]);
const TOOL_EVENTS = new Set(["posttooluse", "posttoolusefailure"]);
const END_EVENTS = new Set(["stop", "sessionend"]);

/**
 * Records one Cursor hook event in the state dir and, at stop or sessionEnd, exports the run's trace. A turn starts at
 * sessionStart or beforeSubmitPrompt and ends at the next stop or sessionEnd (`-p` runs fire no stop). Returns the
 * exported spans, or null.
 */
export async function hookTrace(msg, { env = process.env, now = Date.now } = {}) {
  // A launcher that traces the run itself (builder, runner-owned session) marks its Cursor process.
  if (env[TRACE_ENV] || env.AI_COLLAB_OWNED) return null;
  const endpoint = otlpEndpoint(env);
  const label = sessionLabel(msg.conversation_id || msg.session_id);
  if (!endpoint || !label) return null;
  const key = String(msg.hook_event_name || "").toLowerCase();
  const dir = path.join(stateDir(env), HOOK_DIR);
  const file = path.join(dir, `${label}.jsonl`);
  const at = now();
  const add = (record) => { mkdirSync(dir, { recursive: true, mode: 0o700 }); appendFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 }); };
  if (START_EVENTS.has(key) && !existsSync(file)) add({ start: at, model: msg.model });
  if (TOOL_EVENTS.has(key)) {
    const duration = Number(msg.duration) || 0;
    add({ tool: String(msg.tool_name || "tool"), id: msg.tool_use_id, at, duration, input: msg.tool_input, failed: key === "posttoolusefailure", model: msg.model });
  }
  if (!END_EVENTS.has(key) || !existsSync(file)) return null;
  // Claimed by rename, so a second registration of the same hook finds nothing to export.
  const claimed = `${file}.${process.pid}.${newId(4)}`;
  try { renameSync(file, claimed); } catch { return null; }
  let records = [];
  try {
    records = readFileSync(claimed, "utf8").split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } finally {
    rmSync(claimed, { force: true });
  }
  const seen = new Set();
  const tools = [];
  for (const r of records) {
    if (!r.tool || (r.id && seen.has(r.id))) continue;
    if (r.id) seen.add(r.id);
    tools.push({ name: r.tool, startMs: r.at - Math.round(r.duration), endMs: r.at, input: r.input, failed: r.failed });
  }
  const durationMs = Number(msg.duration_ms) || 0;
  const startMs = Math.min(records.find((r) => r.start)?.start ?? at, durationMs ? at - durationMs : at, ...tools.map((t) => t.startMs));
  const model = records.find((r) => r.start && r.model)?.model || records.find((r) => r.model)?.model || msg.model;
  const status = typeof msg.final_status === "string" ? msg.final_status : typeof msg.status === "string" ? msg.status : "ok";
  const spans = runSpans({ address: `cursor#${label}`, role: env[ROLE_ENV] || "session", model, startMs, endMs: at, tools, status });
  await exportSpans(spans, { endpoint });
  return spans;
}
