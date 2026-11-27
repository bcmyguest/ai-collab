/**
 * spawn_agent: a session starts a child agent of any harness through the runner and gets its address at once.
 * The child runs managed (native subagents off) and messages its parent after every finished run (runner/runner.mjs
 * reportToParent). docs/spawn-agent-spec.md Part B.
 */
import { modelShape, parseHarnessModel } from "./harness.ts";
import { runnerRequest, runnerSocket } from "./runner-request.mjs";
import { checkPrompt } from "./sessions/launch.ts";

export const SPAWN_MAX_CHILDREN = 4; // live spawned children per parent
export const SPAWN_MAX_DEPTH = 2; // a spawned agent may spawn once more
export const REPORT_PREFIX = "[spawn_agent]";
export const REPORT_TEXT_MAX = 3500; // stays under BODY's 4000 (lib/surfaces/schema.ts)
export const SPAWN_NOTE = "It reports to you by message when each run ends; reply with send. wait until=message blocks for the report.";
const RUNNER_DOWN = "spawn_agent needs the ai-collab runner (systemctl --user start ai-collab-runner)";
const CHILD_ADDRESS = /^(claude|codex|cursor|opencode)#([a-f0-9]{16})$/;
// Socket errors that mean no runner is listening.
const DOWN_CODES = new Set(["ECONNREFUSED", "ENOENT"]);

export type SpawnInput = { harness: string; model?: string; brief: string; worktree?: boolean };
export type SpawnResult = { status: "started"; session: string; harness: string; model: string; cwd: string; note: string };
type SpawnCfg = { project: string; peer: string; session?: string };
type Request = (method: string, path: string, body: unknown, options: { socket: string }) => Promise<{ status: number; body: Record<string, unknown> | null }>;

/** Starts a managed child session through the runner and returns its address at once. */
export async function spawnAgent(cfg: SpawnCfg, input: SpawnInput, { env = process.env, request = runnerRequest as Request }: { env?: NodeJS.ProcessEnv; request?: Request } = {}): Promise<SpawnResult> {
  if (!cfg.session || !cfg.peer) throw new Error("spawn_agent needs this session's address; pass session");
  const parent = `${cfg.peer}#${cfg.session}`;
  const parsed = parseHarnessModel(input.harness);
  if (!parsed) throw new Error(`"${input.harness}" is not a harness or harness:model`);
  const model = input.model ?? parsed.model;
  if (input.model !== undefined && !modelShape(parsed.harness, input.model)) throw new Error(`"${input.model}" is not a ${parsed.harness} model name`);
  const checked = checkPrompt(input.brief);
  if (checked.error) throw new Error(checked.error);
  const body = {
    project: cfg.project, harness: parsed.harness, prompt: checked.text, place: input.worktree ? "worktree" : "folder",
    managed: true, parent, spawn: true, system: false, ...(model ? { model } : {}),
  };
  let reply;
  try {
    reply = await request("POST", "/v1/sessions", body, { socket: runnerSocket(env) });
  } catch (error) {
    if (DOWN_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw new Error(RUNNER_DOWN);
    throw error;
  }
  if (reply.status !== 201 || typeof reply.body?.session !== "string") {
    const message = typeof reply.body?.error === "string" ? reply.body.error : `runner start returned HTTP ${reply.status}`;
    throw Object.assign(new Error(message), { status: reply.status });
  }
  return {
    status: "started", session: reply.body.session, harness: parsed.harness, model,
    cwd: typeof reply.body.cwd === "string" ? reply.body.cwd : "", note: SPAWN_NOTE,
  };
}

/** Closes a child this session spawned; the runner refuses any other session. */
export async function closeAgent(cfg: SpawnCfg, to: string, { env = process.env, request = runnerRequest as Request }: { env?: NodeJS.ProcessEnv; request?: Request } = {}): Promise<{ status: string; session: string }> {
  if (!cfg.session || !cfg.peer) throw new Error("close_agent needs this session's address; pass session");
  const match = CHILD_ADDRESS.exec(to);
  if (!match) throw new Error(`"${to}" is not a session address`);
  let reply;
  try {
    reply = await request("POST", `/v1/sessions/${match[1]}/${match[2]}/close-child`, { parent: `${cfg.peer}#${cfg.session}` }, { socket: runnerSocket(env) });
  } catch (error) {
    if (DOWN_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw new Error(RUNNER_DOWN.replace("spawn_agent", "close_agent"));
    throw error;
  }
  if (reply.status !== 200 || typeof reply.body?.status !== "string") {
    const message = typeof reply.body?.error === "string" ? reply.body.error : `runner close returned HTTP ${reply.status}`;
    throw Object.assign(new Error(message), { status: reply.status });
  }
  return { status: reply.body.status, session: to };
}

/** The brief with a line naming the parent, unless the brief already names it; the runner counts it against the prompt limit. */
export function spawnBriefNote(brief: string, parent: string): string {
  if (brief.includes(parent)) return brief;
  return `${brief.trimEnd()}\n\n[ai-collab] You were started by ${parent}; your result reaches it automatically when your run ends.`;
}

/** The line a spawned child's first prompt ends with: a runner-owned session has no hook context, so it learns its own label here. */
export function spawnSelfNote(address: string): string {
  return `\n\n[ai-collab] Spawned agent: your address is ${address}; pass session "${address.split("#")[1]}" to ai-collab tools.`;
}

/** The direct message a child sends its parent when a run ends: the outcome and the reply's last REPORT_TEXT_MAX code units. */
export function spawnReport(child: string, outcome: string, text: string): string {
  const trimmed = text.trim();
  let kept = trimmed;
  if (trimmed.length > REPORT_TEXT_MAX) {
    kept = trimmed.slice(-REPORT_TEXT_MAX);
    // A cut through a surrogate pair drops the orphaned low half.
    if (/^[\uDC00-\uDFFF]/.test(kept)) kept = kept.slice(1);
    kept = `…${kept}`;
  }
  return `${REPORT_PREFIX} ${child} finished (${outcome}):\n${kept || "(no reply text)"}`;
}
