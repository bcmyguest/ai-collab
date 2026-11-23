#!/usr/bin/env node
// MCP server "ai-collab-code": tools that run a JavaScript program in an OpenShell sandbox (lib/code-run.mjs).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { toolClient } from "../lib/tool-api.mjs";
import { BOOTSTRAP, RUN_CODE, RUN_READ_CODE, TIMEOUT_DEFAULT_MS, TIMEOUT_MAX_MS, CODE_MAX_CHARS, codeSandbox, formatRun, hostCaller, prepareSandbox, programArgv, removeCodeSandbox, runCodeTool, runProgram } from "../lib/code-run.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const INSTRUCTIONS = "run_code runs one JavaScript program in an OpenShell sandbox with an `ai` client for the ai-collab tools; "
  + "use it when a task needs many ai-collab calls (list, filter, join) and only the answer should come back. Use run_read_code to gather evidence through the read-only ai API.";
const SESSION = /^[a-f0-9]{16}$/;
const protocolVersions = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
const builder = process.argv[2] === "--builder-local";
const workdir = process.argv[3];
if (builder && (!process.env.OPENSHELL_SANDBOX || !workdir?.startsWith("/sandbox/work/"))) {
  throw new Error("Builder run_code requires an OpenShell builder worktree");
}
const client = builder ? null : toolClient({ host: process.argv[2] || "" });
const active = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

// One run_code call: checks its input, prepares the sandbox, runs the program, and returns the capped result text.
async function runCode(args, signal, readOnly) {
  const { code, session, timeout_ms: timeoutMs = TIMEOUT_DEFAULT_MS } = args;
  if (typeof code !== "string" || !code.trim() || code.length > CODE_MAX_CHARS) throw new Error(`code must be 1-${CODE_MAX_CHARS} characters`);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > TIMEOUT_MAX_MS) throw new Error(`timeout_ms must be 1000-${TIMEOUT_MAX_MS}`);
  if (builder) {
    signal.throwIfAborted();
    const helper = fileURLToPath(new URL("../lib/builder-code.cjs", import.meta.url));
    const argv = [process.execPath, "--max-old-space-size=256", "-e", BOOTSTRAP, helper];
    const run = await runProgram({ argv, code, env: process.env, cwd: workdir, timeoutMs, signal, builder });
    return { text: formatRun(run), isError: !run.ok };
  }
  if (typeof session !== "string" || !SESSION.test(session)) throw new Error("Pass the session label supplied by the ai-collab hook");
  const sandbox = codeSandbox(process.env, { readOnly });
  try {
    await prepareSandbox({ sandbox });
    const argv = await programArgv(sandbox);
    signal.throwIfAborted();
    const run = await runProgram({
      argv, code, env: process.env, timeoutMs, signal, readOnly,
      callTool: hostCaller({ client, session, signal, readOnly }),
    });
    return { text: formatRun(run), isError: !run.ok };
  } finally {
    if (readOnly) await removeCodeSandbox(sandbox);
  }
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
      instructions: builder ? "Batch related worktree operations with run_code." : INSTRUCTIONS,
    } });
  } else if (method === "ping") {
    send({ id, result: {} });
  } else if (method === "tools/list") {
    const tools = client?.listTools();
    send({ id, result: { tools: builder ? [runCodeTool([], { builder })] : [runCodeTool(tools), runCodeTool(tools, { readOnly: true })] } });
  } else if (method === "tools/call") {
    const controller = new AbortController();
    active.set(id, controller);
    try {
      if (params?.name !== RUN_CODE && (builder || params?.name !== RUN_READ_CODE)) throw new Error("Unknown tool");
      const { text, isError } = await runCode(params?.arguments ?? {}, controller.signal, params.name === RUN_READ_CODE);
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
