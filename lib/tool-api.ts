import { loadConfig, ownEnv } from "./config.mjs";
import { schemaProblem } from "./code-run.mjs";
import { OPS } from "./surfaces/ops.ts";
import type { Cfg } from "./messaging.ts";

type Op = (typeof OPS)[number];
type ToolContext = { environment: NodeJS.ProcessEnv; cwd: string; host: string; signal?: AbortSignal };

const BUILDER_START = "builder_start";
const builderStartOnHost = (env: NodeJS.ProcessEnv) => !env.OPENSHELL_SANDBOX && !env.AI_COLLAB_BUILDER && !env.AI_COLLAB_SANDBOX_OUT;
const listed = (env: NodeJS.ProcessEnv) => OPS.filter((op) => op.surfaces.includes("mcp") && (op.name !== BUILDER_START || builderStartOnHost(env)) && (!op.available || op.available(env)));
const definition = ({ name, description, inputSchema }: Op) => ({ name, description, inputSchema });

/** In-process client for programs running under an operator-configured OpenShell policy. */
export function toolClient({ env = process.env, cwd = process.cwd(), host = "" }: { env?: NodeJS.ProcessEnv; cwd?: string; host?: string } = {}) {
  return {
    listTools: () => structuredClone(listed(env).map(definition)),
    callTool: (name: string, args: Record<string, unknown> = {}, { signal }: { signal?: AbortSignal } = {}) => callTool(name, args, { environment: env, cwd, host, signal }),
  };
}

async function callTool(name: string, args: Record<string, unknown>, { environment, cwd, host, signal }: ToolContext) {
  signal?.throwIfAborted();
  const op = listed(environment).find((candidate) => candidate.name === name);
  if (!op) throw new Error("Unknown tool");
  if (op.name === BUILDER_START) {
    const problem = schemaProblem(op.inputSchema, args);
    if (problem) throw new Error(problem);
  }
  // A child agent's MCP server inherits its parent's environment; ownEnv drops the parent's identity.
  const env = ownEnv(environment, host);
  const cfg = loadConfig(op.listing ? { ...env, AI_COLLAB_PEER: env.AI_COLLAB_PEER || host || "operator" } : env, { cwd, host, session: args.session as string | undefined }) as Cfg;
  if (!cfg.enabled) throw new Error(cfg.reason);
  if (op.needsSession && !cfg.session) throw new Error("Pass the session label supplied by the ai-collab hook");
  return op.handler(args, { cfg, env, host, signal });
}
