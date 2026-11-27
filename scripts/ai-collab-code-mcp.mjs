#!/usr/bin/env node
// MCP server "ai-collab-code": tools that run a JavaScript program in an OpenShell sandbox (lib/code-run.ts).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toolClient } from "../lib/tool-api.ts";
import { BOOTSTRAP, RUN_CODE, RUN_READ_CODE, TIMEOUT_DEFAULT_MS, TIMEOUT_MAX_MS, CODE_MAX_CHARS, codeSandbox, programSource, formatRun, hostCaller, prepareSandbox, programArgv, removeCodeSandbox, runCodeTool, runProgram } from "../lib/code-run.ts";
import { serveMcp } from "../lib/surfaces/render-mcp.ts";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const INSTRUCTIONS = "run_code runs one JavaScript program in an OpenShell sandbox with an `ai` client for the ai-collab tools; "
  + "use it when a task needs many ai-collab calls (list, filter, join) and only the answer should come back. Use run_read_code to gather evidence through the read-only ai API.";
const SESSION = /^[a-f0-9]{16}$/;
const builder = process.argv[2] === "--builder-local";
const workdir = process.argv[3];
if (builder && (!process.env.OPENSHELL_SANDBOX || !workdir?.startsWith("/sandbox/work/"))) {
  throw new Error("Builder run_code requires an OpenShell builder worktree");
}
const client = builder ? null : toolClient({ host: process.argv[2] || "" });

// One run_code call: checks its input, prepares the sandbox, runs the program, and returns the capped result text.
async function runCode(args, signal, readOnly) {
  const { session, timeout_ms: timeoutMs = TIMEOUT_DEFAULT_MS } = args;
  const code = programSource(args, { cwd: builder ? workdir : process.cwd() });
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

serveMcp({
  name: "ai-collab-code",
  version: VERSION,
  instructions: builder ? "Batch related worktree operations with run_code." : INSTRUCTIONS,
  listTools: () => {
    const tools = client?.listTools();
    return builder ? [runCodeTool([], { builder })] : [runCodeTool(tools), runCodeTool(tools, { readOnly: true })];
  },
  callTool: async (name, args, signal) => {
    if (name !== RUN_CODE && (builder || name !== RUN_READ_CODE)) throw new Error("Unknown tool");
    return runCode(args, signal, name === RUN_READ_CODE);
  },
});
