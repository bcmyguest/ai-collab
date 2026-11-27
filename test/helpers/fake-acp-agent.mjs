#!/usr/bin/env node
// Scriptable fake cursor-agent for test/cursor-acp-harden.test.mjs: top-level flags before `acp`, config options,
// session/resume, replay on session/load, Cursor's ask_question permission fallback, and repeated tool approvals.
// FAKE_ACP_LOG gets one JSON line per argv, RPC and decision; FAKE_ACP_CAPS (JSON) is merged into agentCapabilities.
import { appendFileSync } from "node:fs";

const log = (entry) => { if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, `${JSON.stringify(entry)}\n`); };
const args = process.argv.slice(2);
if (!args.length) process.exit(0); // loaded by the test glob; no argv means no-op
log({ kind: "argv", args });
if (args[0] === "--version") { process.stdout.write("2026.11.22-fake\n"); process.exit(0); }
// `acp` takes no options of its own (`agent acp --help`), so it must come last.
if (args.at(-1) !== "acp") { process.stderr.write(`fake acp agent: acp must be the last argument: ${args.join(" ")}\n`); process.exit(2); }

const SESSION = "fake-acp-session";
const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId, body) => write({ method: "session/update", params: { sessionId, update: body } });
let model = "composer-2.5";
const configOptions = () => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: [
    { value: "composer-2.5", name: "Composer 2.5" },
    { group: "other", name: "Other", options: [{ value: "gpt-5", name: "GPT-5" }] },
  ] },
  { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }, { value: "low", name: "Low" }] },
];
let nextRequestId = 900;
const waiting = new Map();

function ask(params) {
  const rpcId = nextRequestId++;
  const decision = new Promise((resolve) => waiting.set(rpcId, resolve));
  write({ id: rpcId, method: "session/request_permission", params });
  return decision;
}

async function prompt(id, sessionId, text) {
  if (/\bquestion\b/.test(text)) {
    // The shape cursor-agent 2026.11.22 sends when the client does not serve cursor/ask_question.
    const response = await ask({ sessionId,
      toolCall: { toolCallId: "ask-1_q0", title: "Pick a colour", kind: "other", status: "pending", content: [{ type: "content", content: { type: "text", text: "Which colour?" } }] },
      options: [{ optionId: "red", name: "Red", kind: "allow_once" }, { optionId: "blue", name: "Blue", kind: "allow_once" }, { optionId: "__ask_question_skip__", name: "Skip", kind: "reject_once" }],
    });
    log({ kind: "decision", response });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `picked ${response.outcome?.optionId}` } });
  }
  const tools = /\btools (\d+)\b/.exec(text);
  for (let i = 0; i < Number(tools?.[1] ?? 0); i++) {
    const response = await ask({ sessionId,
      toolCall: { toolCallId: `tool-${i}`, title: "Shell", kind: "execute", rawInput: { command: `ls ${i}` } },
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "allow-always", name: "Allow always", kind: "allow_always" }, { optionId: "reject-once", name: "Reject", kind: "reject_once" }],
    });
    log({ kind: "decision", response });
  }
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `echo: ${text}` } });
  write({ id, result: { stopReason: "end_turn" } });
}

const caps = JSON.parse(process.env.FAKE_ACP_CAPS || "{}");
let buffer = "";
const idle = setTimeout(() => process.exit(1), 60_000);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  idle.refresh();
  buffer += chunk;
  for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    log({ kind: "rpc", method: msg.method, params: msg.params ?? null, id: msg.id ?? null });
    if (msg.id !== undefined && msg.method === undefined) { waiting.get(msg.id)?.(msg.result ?? {}); waiting.delete(msg.id); continue; }
    switch (msg.method) {
      case "initialize":
        write({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, ...caps }, authMethods: [] } });
        break;
      case "session/new":
        write({ id: msg.id, result: { sessionId: SESSION, models: { currentModelId: model, availableModels: [{ modelId: model, name: "Composer 2.5" }] }, configOptions: configOptions() } });
        break;
      case "session/load":
        // A real agent replays the conversation before it answers; the adapter must not surface any of it.
        update(msg.params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old prompt" } });
        update(msg.params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "replayed history" } });
        update(msg.params.sessionId, { sessionUpdate: "tool_call", toolCallId: "old-tool", title: "Shell", kind: "execute", rawInput: {} });
        setTimeout(() => write({ id: msg.id, result: { configOptions: configOptions() } }), 20);
        break;
      case "session/resume":
        write({ id: msg.id, result: { configOptions: configOptions() } });
        break;
      case "session/set_config_option":
        if (msg.params.configId === "model") model = msg.params.value;
        write({ id: msg.id, result: { configOptions: configOptions() } });
        break;
      case "session/prompt":
        prompt(msg.id, msg.params.sessionId, msg.params.prompt.map((b) => b.text).join("\n"));
        break;
      case "session/cancel":
        for (const [rpcId, resolve] of waiting) { resolve({ outcome: { outcome: "cancelled" } }); waiting.delete(rpcId); }
        break;
      default:
        if (msg.id !== undefined) write({ id: msg.id, error: { code: -32601, message: `unknown ${msg.method}` } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
