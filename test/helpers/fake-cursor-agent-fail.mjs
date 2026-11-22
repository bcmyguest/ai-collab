#!/usr/bin/env node
// Fake cursor-agent for the limit/error tests: speaks ACP long enough for a prompt, then fails the way a provider limit does.
// FAKE_CURSOR_FAIL picks the failure: "acp-error" (JSON-RPC error with code and data), "stderr-exit" (exit 1 with stderr text),
// "structured-code" (JSON-RPC error whose code names a usage limit). Test-only; never starts the real CLI.
import { appendFileSync } from "node:fs";

const log = (entry) => { if (process.env.FAKE_CURSOR_LOG) appendFileSync(process.env.FAKE_CURSOR_LOG, `${JSON.stringify(entry)}\n`); };
const args = process.argv.slice(2);
if (!args.length) process.exit(0); // loaded by the test glob; no argv means no-op
log({ kind: "argv", args, cwd: process.cwd(), owned: process.env.AI_COLLAB_OWNED ?? null });
if (args[0] === "--version") { process.stdout.write("2026.11.22-fake\n"); process.exit(0); }
if (args[0] === "--list-models") { process.stdout.write("fake-1\n"); process.exit(0); }
if (args[0] !== "acp") { process.stderr.write(`fake cursor-agent: unexpected argv ${args.join(" ")}\n`); process.exit(2); }

const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const SESSION = "fake-cursor-session";
const FAIL = process.env.FAKE_CURSOR_FAIL ?? "acp-error";

function failPrompt(id) {
  if (FAIL === "stderr-exit") {
    process.stderr.write("cursor-agent: HTTP 429 Too Many Requests\n");
    process.stderr.write(process.env.FAKE_CURSOR_STDERR ?? "You've reached your usage limit for the 5-hour window. Resets soon.\n");
    process.exit(1);
  }
  if (FAIL === "structured-code") {
    write({ id, error: { code: "usage_limit_exceeded", message: "provider rejected the request", data: { type: "usage_limit", retryable: false } } });
    return;
  }
  // ACP error with both code and data: the adapter must keep both, not only the message.
  write({ id, error: { code: -32000, message: "provider error: weekly usage limit reached", data: { status: 429, limit: "seven_day" } } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    log({ kind: "rpc", method: msg.method, params: msg.params ?? null, id: msg.id ?? null });
    if (msg.id !== undefined && msg.method === undefined) continue;
    switch (msg.method) {
      case "initialize": write({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } }); break;
      case "session/new": write({ id: msg.id, result: { sessionId: SESSION } }); break;
      case "session/prompt": failPrompt(msg.id); break;
      default: if (msg.id !== undefined) write({ id: msg.id, error: { code: -32601, message: `unknown ${msg.method}` } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
