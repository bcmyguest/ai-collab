// Builder identity, state file and constants: the paths and phases every other builder module shares.
import { writeJson } from "../store.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir } from "../config.mjs";
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

/** Unit, sandbox, worktree and state paths for one builder id. */
export function builderPaths(id, env = process.env) {
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
export function builderSandbox(id) {
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 6);
  return `b-${id.slice(0, SANDBOX_PREFIX_MAX).replace(/-+$/, "")}-${hash}`;
}

/** The builder id for a task id: lowercase letters, digits and dashes, at most 63 characters. */
export function builderId(taskId) {
  return String(taskId).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
}

export function readState(paths) {
  return JSON.parse(readFileSync(paths.state, "utf8"));
}

export function writeState(paths, state) {
  writeJson(paths.state, state, { indent: 2 });
}

export function updateState(paths, patch) {
  let state = {};
  try { state = readState(paths); } catch { /* first write */ }
  writeState(paths, { ...state, ...patch, updated: Date.now() });
}

export function builderExited(state) {
  if (FINAL_PHASES.includes(state.phase)) return true;
  if (state.owned || !Number.isSafeInteger(state.pid) || state.pid <= 0) return false;
  try { process.kill(state.pid, 0); } catch (error) { return error.code === "ESRCH"; }
  return false;
}

export function oneLine(text) {
  return String(text).replace(/\s+/g, " ").trim();
}
