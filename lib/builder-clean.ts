/** Keep at most BUILDER_DIR_CAP builder state directories. Running and staging stay. */
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { stateDir } from "./config.ts";

export const BUILDER_DIR_CAP = 50;
export const BUILDER_LIVE_CAP = 2;
// Oldest finished go first, then oldest failed, then oldest stopped.
const PHASE_RANK = { finished: 0, failed: 1, stopped: 2 } as const;
export const PROTECTED_CHECKOUTS = ["/home/b/ai-collab", "/home/b/ai-collab-serving"];

type Env = NodeJS.ProcessEnv;
type Row = { id: string; phase: string; mtime: number; root?: string; worktree?: string };

function covers(base: string, candidate: string) {
  const root = path.resolve(base);
  const target = path.resolve(candidate);
  return target === root || target.startsWith(root + path.sep);
}

/** True when `candidate` is the project checkout, the ai-collab checkout, or the serving checkout. */
export function worktreeIsProtected(candidate: string, repoRoot: string) {
  const targets = [candidate];
  try { targets.push(realpathSync(candidate)); } catch { /* path is already gone */ }
  const bases = [repoRoot, ...PROTECTED_CHECKOUTS].filter(Boolean);
  for (const base of bases) {
    const resolved = [base];
    try { resolved.push(realpathSync(base)); } catch { /* checkout is not on this machine */ }
    for (const root of resolved) {
      for (const target of targets) {
        if (covers(root, target)) return true;
      }
    }
  }
  return false;
}

/**
 * Ids to delete so `rows.length` is at most `cap`.
 * Order: oldest finished, then oldest failed, then oldest stopped (state.json mtime).
 * Running, staging, and every other phase are kept.
 */
export function buildersToRemove(rows: Row[], cap = BUILDER_DIR_CAP) {
  const overflow = rows.length - cap;
  if (overflow <= 0) return [];
  return rows
    .filter((row) => Object.hasOwn(PHASE_RANK, row.phase))
    .sort((a, b) => PHASE_RANK[a.phase as keyof typeof PHASE_RANK] - PHASE_RANK[b.phase as keyof typeof PHASE_RANK] || a.mtime - b.mtime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, overflow)
    .map((row) => row.id);
}

function builderWorktree(id: string, env: Env) {
  const home = env.HOME || homedir();
  return path.join(env.AI_COLLAB_BUILDER_WORKTREES || home, `ai-collab-wt-${id}`);
}

function buildersRoot(env: Env) {
  return path.join(stateDir(env), "builders");
}

function safeId(id: unknown) {
  return typeof id === "string" && id !== "." && id !== ".." && id === path.basename(id) && !id.includes("\0");
}

/** Error text when `cap` builders are already running or staging, else "". */
export function builderLiveRefusal(env: Env, cap = BUILDER_LIVE_CAP) {
  const live = listBuilders(env).filter((row) => row.phase === "running" || row.phase === "staging");
  if (live.length < cap) return "";
  return `${cap} builders are already running or staging (${live.map((row) => row.id).join(", ")})`;
}

function listBuilders(env: Env): Row[] {
  const root = buildersRoot(env);
  if (!existsSync(root)) return [];
  const rows: Row[] = [];
  for (const id of readdirSync(root)) {
    if (!safeId(id)) continue;
    const dir = path.join(root, id);
    let info;
    try { info = lstatSync(dir); } catch { continue; }
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    const file = path.join(dir, "state.json");
    try {
      const st = statSync(file);
      const data = JSON.parse(readFileSync(file, "utf8"));
      rows.push({ id, phase: data.phase, mtime: st.mtimeMs, root: data.root, worktree: data.worktree });
    } catch {
      rows.push({ id, phase: "unreadable", mtime: info.mtimeMs });
    }
  }
  return rows;
}

function gitEnv(env: Env) {
  const next = { ...env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete next[key];
  return next;
}

function git(repo: string, args: string[], env: Env) {
  return new Promise<string>((resolve, reject) => {
    execFile("git", ["-C", repo, ...args], { env: gitEnv(env), timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) {
        (error as Error & { stderr?: string }).stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function linkedToRepo(worktree: string, repoRoot: string) {
  const gitfile = path.join(worktree, ".git");
  let info;
  try { info = lstatSync(gitfile); } catch { return false; }
  if (!info.isFile()) return false;
  const text = readFileSync(gitfile, "utf8").trim();
  const match = text.match(/^gitdir:\s*(.+)$/);
  if (!match) return false;
  let gitdir;
  let admin;
  try {
    gitdir = realpathSync(path.resolve(worktree, match[1]));
    admin = realpathSync(path.join(repoRoot, ".git", "worktrees"));
  } catch { return false; }
  return gitdir.startsWith(admin + path.sep);
}

// --force: a finished worktree often still has the node_modules link or other untracked files.
async function removeWorktree(row: Row, env: Env) {
  const expected = builderWorktree(row.id, env);
  if (row.worktree && path.resolve(row.worktree) !== path.resolve(expected)) return "mismatch";
  let info;
  try { info = lstatSync(expected); } catch { return "absent"; }
  if (!info.isDirectory() && !info.isSymbolicLink()) return "absent";
  const repo = typeof row.root === "string" ? row.root : "";
  if (!repo || worktreeIsProtected(expected, repo)) return "protected";
  if (!linkedToRepo(expected, repo)) return "unrelated";
  const run = (args: string[]) => git(repo, ["worktree", "remove", ...args, expected], env);
  try {
    await run(["--force"]);
  } catch (error) {
    const text = `${(error as Error & { stderr?: string }).stderr || ""} ${(error as Error).message || ""}`;
    if (!/locked/i.test(text)) return "fail";
    try { await run(["--force", "--force"]); } catch { return "fail"; }
  }
  return existsSync(expected) ? "fail" : "removed";
}

function removeState(env: Env, id: string) {
  if (!safeId(id)) return false;
  const root = buildersRoot(env);
  const dir = path.join(root, id);
  if (path.resolve(dir) !== path.join(path.resolve(root), id)) return false;
  let info;
  try { info = lstatSync(dir); } catch { return false; }
  if (!info.isDirectory() || info.isSymbolicLink()) return false;
  let data;
  try { data = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")); } catch { return false; }
  if (!Object.hasOwn(PHASE_RANK, data.phase)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** Delete oldest finished, then failed, then stopped state dirs until `cap` remain. Returns removed ids. */
export async function cleanBuilders(env: Env = process.env, { cap = BUILDER_DIR_CAP }: { cap?: number } = {}) {
  const removed: string[] = [];
  for (const id of buildersToRemove(listBuilders(env), cap)) {
    const rows = listBuilders(env);
    const row = rows.find((item) => item.id === id);
    if (!row || !Object.hasOwn(PHASE_RANK, row.phase)) continue;
    const outcome = await removeWorktree(row, env);
    if (outcome === "fail") continue;
    if (removeState(env, id)) removed.push(id);
  }
  return removed;
}
