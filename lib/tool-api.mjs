import { loadConfig, ownEnv } from "./config.mjs";
import { schemaProblem } from "./code-run.mjs";
import { OPS } from "./surfaces/ops.ts";

const BUILDER_START = "builder_start";
const builderStartOnHost = (env) => !env.OPENSHELL_SANDBOX && !env.AI_COLLAB_BUILDER && !env.AI_COLLAB_SANDBOX_OUT;
const listed = (env) => OPS.filter((op) => op.surfaces.includes("mcp") && (op.name !== BUILDER_START || builderStartOnHost(env)));
const definition = ({ name, description, inputSchema }) => ({ name, description, inputSchema });

/** In-process client for programs running under an operator-configured OpenShell policy. */
export function toolClient({ env = process.env, cwd = process.cwd(), host = "" } = {}) {
  return {
    listTools: () => structuredClone(listed(env).map(definition)),
    callTool: (name, args = {}, { signal } = {}) => callTool(name, args, { environment: env, cwd, host, signal }),
  };
}

async function callTool(name, args, { environment, cwd, host, signal }) {
  signal?.throwIfAborted();
  const op = listed(environment).find((candidate) => candidate.name === name);
  if (!op) throw new Error("Unknown tool");
  if (op.name === BUILDER_START) {
    const problem = schemaProblem(op.inputSchema, args);
    if (problem) throw new Error(problem);
  }
  // A child agent's MCP server inherits its parent's environment; ownEnv drops the parent's identity.
  const env = ownEnv(environment, host);
  const cfg = loadConfig(op.listing ? { ...env, AI_COLLAB_PEER: env.AI_COLLAB_PEER || host || "operator" } : env, { cwd, host, session: args.session });
  if (!cfg.enabled) throw new Error(cfg.reason);
  if (op.needsSession && !cfg.session) throw new Error("Pass the session label supplied by the ai-collab hook");
  return op.handler(args, { cfg, env, host, signal });
}
