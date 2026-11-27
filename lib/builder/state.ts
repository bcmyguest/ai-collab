// Builder identity, state file and constants: the paths and phases every other builder module shares.
import { writeJson } from "../store.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir } from "../config.ts";
import { FALLBACK_MODEL } from "../harness.ts";

export const CLI_SCRIPT = fileURLToPath(new URL("../../scripts/ai-collab.mjs", import.meta.url));

// The ai-collab checkout this CLI runs from supplies the builder MCP servers.
export const APP_ROOT = dirname(dirname(CLI_SCRIPT));

export const BUILDER_HARNESSES = Object.freeze(["cursor", "codex", "claude", "opencode"]);

export const DEFAULT_MODEL = { cursor: FALLBACK_MODEL, codex: "gpt-6.2-sol", claude: "haiku", opencode: "opencode/deepseek-v4.1-flash-free" };

const UNIT_PREFIX = "builder-";

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const BASE_REF = "main";

// openshell 0.1.9 refuses a sandbox name over 19 characters (measured 2026-11-22).
const SANDBOX_PREFIX_MAX = 8;

export const BUILDER_START_TIMEOUT_MS = 15 * 60_000;

export const GIT_TIMEOUT_MS = 600_000;

export const SYNC_TIMEOUT_MS = 900_000;

export const FINAL_PHASES = ["finished", "failed", "stopped"];

export const LIVE_STATES = ["active", "activating", "deactivating", "reloading"];

export type Env = NodeJS.ProcessEnv;
export type BuilderPaths = ReturnType<typeof builderPaths>;
/** A builder's state.json: phases and fields every module reads loosely. */
// oxlint-disable-next-line typescript/no-explicit-any -- state.json is untyped JSON every builder module reads loosely
export type BuilderState = Record<string, any>;

/** Unit, sandbox, worktree and state paths for one builder id. */
export function builderPaths(id: string, env: Env = process.env) {
  const home = env.HOME || homedir();
  const dir = join(stateDir(env), "builders", id);
  return {
    unit: `${UNIT_PREFIX}${id}`,
    sandbox: builderSandbox(id),
    worktree: join(env.AI_COLLAB_BUILDER_WORKTREES || home, `ai-collab-wt-${id}`),
    dir, state: join(dir, "state.json"), brief: join(dir, "brief.md"), policy: join(dir, "policy.yaml"),
    stage: join(dir, "stage"), back: join(dir, "back"), out: join(dir, "out"),
  };
}

/** A builder's sandbox name: b-<first 8 of the id>-<6 hex of its hash>, at most 17 characters. */
export function builderSandbox(id: string) {
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 6);
  return `b-${id.slice(0, SANDBOX_PREFIX_MAX).replace(/-+$/, "")}-${hash}`;
}

/** The builder id for a task id: lowercase letters, digits and dashes, at most 63 characters. */
export function builderId(taskId: string) {
  return String(taskId).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
}

export function readState(paths: { state: string }): BuilderState {
  return JSON.parse(readFileSync(paths.state, "utf8"));
}

export function writeState(paths: { state: string }, state: unknown) {
  writeJson(paths.state, state, { indent: 2 });
}

export function updateState(paths: { state: string }, patch: Record<string, unknown>) {
  let state: BuilderState = {};
  try { state = readState(paths); } catch { /* first write */ }
  writeState(paths, { ...state, ...patch, updated: Date.now() });
}

export function builderExited(state: BuilderState) {
  if (FINAL_PHASES.includes(state.phase)) return true;
  if (state.owned || !Number.isSafeInteger(state.pid) || state.pid <= 0) return false;
  try { process.kill(state.pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  return false;
}

export function oneLine(text: unknown) {
  return String(text).replace(/\s+/g, " ").trim();
}
