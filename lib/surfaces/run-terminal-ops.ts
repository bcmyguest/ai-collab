// MCP tools for run in terminal (lib/run-terminal.mjs); listed only on the host with runInTerminal on.
import { RUN_ID, REASON_MAX, SCRIPT_MAX_BYTES, TIMEOUT_MAX_S, createRunRequest, onHost, runInTerminalEnabled, waitForRun } from "../run-terminal.mjs";
import { IDENTITY, WAIT } from "./schema.ts";
import { passJs } from "./types.ts";
import type { Op } from "./ops.ts";

const available = (env: NodeJS.ProcessEnv) => onHost(env) && runInTerminalEnabled(env);

export const RUN_TERMINAL_OPS: Op[] = [
  {
    name: "run_in_terminal",
    description: "Propose a bash script for the operator to run on the host. The operator reads the exact script, its cwd, your reason and its sha256 in the UI and clicks Run or Reject; nothing runs without that click. Returns a request id at once; call run_in_terminal_result with it for the exit code and output. A request runs at most once and expires after 15 minutes.",
    inputSchema: {
      type: "object", required: ["script", "cwd", "reason", "session"], additionalProperties: false,
      properties: {
        script: { type: "string", minLength: 1, description: `Bash script, at most ${SCRIPT_MAX_BYTES} bytes; tab and newline are the only control characters allowed.` },
        cwd: { type: "string", minLength: 1, description: "Absolute path of an existing directory to run in." },
        reason: { type: "string", minLength: 1, maxLength: REASON_MAX, description: "One line telling the operator why." },
        session: IDENTITY,
        timeout_s: { type: "integer", minimum: 1, maximum: TIMEOUT_MAX_S, default: 300, description: "Seconds before the script's process group is killed." },
      },
    },
    surfaces: ["mcp"],
    needsSession: true,
    available,
    handler: (args, { cfg, env }) => createRunRequest(passJs(cfg), passJs({ script: args.script, cwd: args.cwd, reason: args.reason, timeoutS: args.timeout_s }), env),
  },
  {
    name: "run_in_terminal_result",
    description: "Wait for a run_in_terminal request: returns status pending, running, done, rejected, expired or refused, and once done the exit code, stdout and stderr tails (16 KB each) and duration. Returns the current status when the wait ends first.",
    inputSchema: {
      type: "object", required: ["id"], additionalProperties: false,
      properties: { id: { type: "string", pattern: RUN_ID.source }, wait_seconds: WAIT },
    },
    surfaces: ["mcp"],
    available,
    handler: (args, { cfg, env, signal }) => {
      if (!available(env)) throw new Error("run_in_terminal runs only on the host with runInTerminal on");
      return waitForRun(passJs(cfg), passJs(args.id), passJs(args.wait_seconds ?? 25), signal);
    },
  },
];
