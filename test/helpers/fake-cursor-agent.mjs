#!/usr/bin/env node
// Fake cursor-agent for runner-adapter-cursor tests: answers --version and --list-models, and speaks ACP for `acp`.
// Every argv is appended to FAKE_CURSOR_LOG as one JSON line; permission decisions go there too.
import { appendFileSync } from "node:fs";

const log = (entry) => { if (process.env.FAKE_CURSOR_LOG) appendFileSync(process.env.FAKE_CURSOR_LOG, `${JSON.stringify(entry)}\n`); };
const args = process.argv.slice(2);
if (!args.length) process.exit(0); // loaded by the test glob; no argv means no-op
log({ kind: "argv", args, cwd: process.cwd(), owned: process.env.AI_COLLAB_OWNED ?? null });

if (args[0] === "--version") { process.stdout.write("2026.11.22-fake\n"); process.exit(0); }
if (args[0] === "--list-models") {
  process.stdout.write("Available models\n\ncomposer-2.5 - Composer 2.5\nfake-1\n");
  process.exit(0);
}
if (args[0] !== "acp") { process.stderr.write(`fake cursor-agent: unexpected argv ${args.join(" ")}\n`); process.exit(2); }

const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const SESSION = "fake-cursor-session";
let nextRequestId = 900;
const waiting = new Map();   // agent->client request id -> resolver
let hang = null;             // resolver of a prompt that waits for session/cancel

function update(sessionId, body) { write({ method: "session/update", params: { sessionId, update: body } }); }

async function prompt(id, sessionId, text) {
  if (/\bapprove\b/.test(text)) {
    const rpcId = nextRequestId++;
    const decision = new Promise((resolve) => waiting.set(rpcId, resolve));
    write({ id: rpcId, method: "session/request_permission", params: {
      sessionId,
      toolCall: { toolCallId: "tool-1", title: "Shell", kind: "execute", rawInput: { command: "ls" } },
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "reject-once", name: "Reject", kind: "reject_once" }],
    } });
    const response = await decision;
    log({ kind: "decision", response });
    const allowed = response.outcome?.optionId === "allow-once";
    if (response.outcome?.outcome === "cancelled") return write({ id, result: { stopReason: "cancelled" } });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: allowed ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: allowed ? "ran ls" : "denied" } }] });
  }
  if (/\bhang\b/.test(text)) {
    const cancelled = new Promise((resolve) => { hang = resolve; });
    await cancelled;
    return write({ id, result: { stopReason: "cancelled" } });
  }
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `echo: ${text}` } });
  write({ id, result: { stopReason: "end_turn" } });
}

let buffer = "";
// Exits after this long with no stdin, so a session a failed test left open cannot keep the test file running.
const IDLE_EXIT_MS = 60_000;
let idle = setTimeout(() => process.exit(0), IDLE_EXIT_MS);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  clearTimeout(idle);
  idle = setTimeout(() => process.exit(0), IDLE_EXIT_MS);
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
        write({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
        break;
      case "session/new":
        if (process.env.FAKE_CURSOR_NEW_ERROR) write({ id: msg.id, error: { code: -32000, message: process.env.FAKE_CURSOR_NEW_ERROR } });
        else write({ id: msg.id, result: { sessionId: SESSION } });
        break;
      case "session/load":
        update(msg.params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "replayed history" } });
        write({ id: msg.id, result: null });
        break;
      case "session/prompt":
        prompt(msg.id, msg.params.sessionId, msg.params.prompt.map((b) => b.text).join("\n"));
        break;
      case "session/cancel":
        hang?.(); hang = null;
        for (const [rpcId, resolve] of waiting) { resolve({ outcome: { outcome: "cancelled" } }); waiting.delete(rpcId); }
        break;
      default:
        if (msg.id !== undefined) write({ id: msg.id, error: { code: -32601, message: `unknown ${msg.method}` } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
