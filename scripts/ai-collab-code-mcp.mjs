#!/usr/bin/env node
// MCP server "ai-collab-code": one tool, run_code, that runs a JavaScript program in an OpenShell sandbox (lib/code-run.mjs).
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { toolClient } from "../lib/tool-api.mjs";
import { RUN_CODE, TIMEOUT_DEFAULT_MS, TIMEOUT_MAX_MS, CODE_MAX_CHARS, formatRun, hostCaller, prepareSandbox, programArgv, runCodeTool, runProgram } from "../lib/code-run.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const INSTRUCTIONS = "run_code runs one JavaScript program in an OpenShell sandbox with an `ai` client for the ai-collab tools; "
  + "use it when a task needs many ai-collab calls (list, filter, join) and only the answer should come back. Its description lists the ai.* API.";
const SESSION = /^[a-f0-9]{16}$/;
const protocolVersions = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
const host = process.argv[2] || "";
const client = toolClient({ host });
const active = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

// One run_code call: checks its input, prepares the sandbox, runs the program, and returns the capped result text.
async function runCode(args, signal) {
  const { code, session, timeout_ms: timeoutMs = TIMEOUT_DEFAULT_MS } = args;
  if (typeof code !== "string" || !code.trim() || code.length > CODE_MAX_CHARS) throw new Error(`code must be 1-${CODE_MAX_CHARS} characters`);
  if (typeof session !== "string" || !SESSION.test(session)) throw new Error("Pass the session label supplied by the ai-collab hook");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > TIMEOUT_MAX_MS) throw new Error(`timeout_ms must be 1000-${TIMEOUT_MAX_MS}`);
  const sandbox = await prepareSandbox({ env: process.env });
  const run = await runProgram({
    argv: await programArgv(sandbox), code, env: process.env, timeoutMs, signal,
    callTool: hostCaller({ client, session, signal }),
  });
  return { text: formatRun(run), isError: !run.ok };
}

async function handle(request) {
  const { id, method, params } = request ?? {};
  if (method === "notifications/cancelled") {
    active.get(params?.requestId)?.abort();
    return;
  }
  if (id === undefined) return;
  if (method === "initialize") {
    const requested = params?.protocolVersion;
    send({ id, result: {
      protocolVersion: protocolVersions.has(requested) ? requested : "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "ai-collab-code", version: VERSION },
      instructions: INSTRUCTIONS,
    } });
  } else if (method === "ping") {
    send({ id, result: {} });
  } else if (method === "tools/list") {
    send({ id, result: { tools: [runCodeTool(client.listTools())] } });
  } else if (method === "tools/call") {
    const controller = new AbortController();
    active.set(id, controller);
    try {
      if (params?.name !== RUN_CODE) throw new Error("Unknown tool");
      const { text, isError } = await runCode(params?.arguments ?? {}, controller.signal);
      if (!controller.signal.aborted) send({ id, result: { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }] } });
    } catch (error) {
      if (!controller.signal.aborted) send({ id, result: { isError: true, content: [{ type: "text", text: error.message }] } });
    } finally {
      active.delete(id);
    }
  } else {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); }
  catch { send({ id: null, error: { code: -32700, message: "Parse error" } }); return; }
  void handle(message);
});
input.on("close", () => {
  for (const controller of active.values()) controller.abort();
});
