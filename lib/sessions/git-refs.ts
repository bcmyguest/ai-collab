// Git ref and worktree lookups for session start: branch and worktree pickers, and validation of caller-supplied refs.
import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { findExecutable } from "./scope.ts";

/** Most refs a picker shows. */
export const REF_LIMIT = 50;
/** Longest ref name accepted from a caller. */
export const REF_NAME_MAX = 200;

const REF_FORMAT = "%(refname)%00%(committerdate:unix)%00%(objectname:short)";
const NOT_A_WORKTREE = "worktree is not one of this project's worktrees";
const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const given = (value: unknown) => value !== undefined && value !== null && value !== "";

/** One record of `git worktree list --porcelain`; branch is the full ref ("refs/heads/x") or null when detached. */
export type WorktreeRecord = { path: string; head: string; branch: string | null; detached: boolean; locked: boolean; prunable: boolean };

/** Records from `git worktree list --porcelain`; the first record is the main worktree. */
export function parseWorktreeList(text: string): WorktreeRecord[] {
  const rows: WorktreeRecord[] = [];
  let row: WorktreeRecord | null = null;
  for (const line of text.split("\n")) {
    if (line === "") {
      if (row) rows.push(row);
      row = null;
    } else if (line.startsWith("worktree ")) {
      row = { path: line.slice("worktree ".length), head: "", branch: null, detached: false, locked: false, prunable: false };
    } else if (row) {
      if (line.startsWith("HEAD ")) row.head = line.slice("HEAD ".length);
      else if (line.startsWith("branch ")) row.branch = line.slice("branch ".length);
      else if (line === "detached") row.detached = true;
      else if (line === "locked" || line.startsWith("locked ")) row.locked = true;
      else if (line === "prunable" || line.startsWith("prunable ")) row.prunable = true;
    }
  }
  if (row) rows.push(row);
  return rows;
}

/** How this module runs git: fixed argv and cwd, resolved exit code and stdout, never rejects. */
export type GitRun = (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;

/** A GitRun over execFile with no shell; a failed spawn or non-zero exit resolves with its code and empty stdout. */
export function gitRunner(gitFile: string, env: NodeJS.ProcessEnv): GitRun {
  return (args, cwd) =>
    new Promise((done) => {
      execFile(gitFile, args, { cwd, env, shell: false, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (error) done({ code: typeof code === "number" ? code : 1, stdout: "" });
        else done({ code: 0, stdout });
      });
    });
}

/** One local or remote-tracking branch: short name, last commit date as unix seconds, short sha. */
export type BranchRef = { name: string; remote: boolean; date: number; sha: string };

/** Refs from `git for-each-ref` output in REF_FORMAT; anything outside refs/heads and refs/remotes is ignored. */
export function parseRefs(text: string): BranchRef[] {
  const refs: BranchRef[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const [refname, when, sha] = line.split("\0");
    if (!refname || !sha) continue;
    const remote = refname.startsWith("refs/remotes/");
    const prefix = remote ? "refs/remotes/" : "refs/heads/";
    const name = refname.startsWith(prefix) ? refname.slice(prefix.length) : "";
    if (name === "" || (remote && name.endsWith("/HEAD"))) continue;
    const date = Number(when);
    refs.push({ name, remote, date: Number.isFinite(date) ? date : 0, sha });
  }
  return refs;
}

/** One page of filtered refs, and whether more matched than it holds. */
export type RefPage<T> = { items: T[]; truncated: boolean };

/** Case-insensitive name filter: exact, prefix, last-segment prefix, then the rest; first `limit` kept. */
export function filterRefs<T extends { name: string }>(refs: T[], query: string, limit = REF_LIMIT): RefPage<T> {
  const q = query.trim().toLowerCase();
  const matches = q === "" ? refs.slice() : refs.filter((ref) => ref.name.toLowerCase().includes(q));
  if (q !== "") {
    const rank = (name: string) => {
      const n = name.toLowerCase();
      if (n === q) return 0;
      if (n.startsWith(q)) return 1;
      return n.slice(n.lastIndexOf("/") + 1).startsWith(q) ? 2 : 3;
    };
    // Array#sort is stable, so input order survives inside each rank.
    matches.sort((a, b) => rank(a.name) - rank(b.name));
  }
  return { items: matches.slice(0, limit), truncated: matches.length > limit };
}

/** Branch picker data: filtered refs and the current branch ("" when HEAD is detached). */
export async function listBranches(run: GitRun, root: string, { query = "", limit = REF_LIMIT } = {}): Promise<{ current: string; branches: BranchRef[]; truncated: boolean }> {
  const [refs, head] = await Promise.all([
    run(["for-each-ref", "--sort=-committerdate", `--format=${REF_FORMAT}`, "refs/heads", "refs/remotes"], root),
    run(["symbolic-ref", "--quiet", "--short", "HEAD"], root),
  ]);
  const { items, truncated } = filterRefs(parseRefs(refs.stdout), query, limit);
  return { current: head.code === 0 ? head.stdout.trim() : "", branches: items, truncated };
}

/** One non-main worktree for the picker. */
export type WorktreeRow = { path: string; branch: string | null; head: string; locked: boolean; dirty: boolean };

/** Non-main worktrees filtered on path or branch; only the kept rows get a dirty check. */
export async function listWorktrees(run: GitRun, root: string, { query = "", limit = REF_LIMIT } = {}): Promise<{ worktrees: WorktreeRow[]; truncated: boolean }> {
  const listing = await run(["worktree", "list", "--porcelain"], root);
  const q = query.trim().toLowerCase();
  const rows: WorktreeRow[] = parseWorktreeList(listing.stdout)
    .slice(1)
    .filter((rec) => !rec.prunable)
    .map((rec) => ({
      path: rec.path,
      branch: rec.branch?.replace(/^refs\/heads\//, "") ?? null,
      head: rec.head,
      locked: rec.locked,
      dirty: false,
    }));
  const matches = q === "" ? rows : rows.filter((row) => row.path.toLowerCase().includes(q) || (row.branch ?? "").toLowerCase().includes(q));
  const worktrees = matches.slice(0, limit);
  await Promise.all(worktrees.map(async (row) => {
    const status = await run(["status", "--porcelain", "--ignore-submodules=dirty"], row.path);
    row.dirty = status.code === 0 && status.stdout.trim() !== "";
  }));
  return { worktrees, truncated: matches.length > limit };
}

/** Why `value` cannot go on a git command line as a ref name; "" when fine. */
export function refInputError(value: unknown, what: string): string {
  if (typeof value !== "string") return `${what} must be a git ref name`;
  const name = value.trim();
  if (name === "") return `${what} must be a git ref name`;
  if (name.length > REF_NAME_MAX) return `${what} must be ${REF_NAME_MAX} characters or fewer`;
  if (name.startsWith("-")) return `${what} cannot start with "-"`;
  if (/[\s\x00-\x1f\x7f]/.test(name)) return `${what} cannot contain whitespace or control characters`;
  if (name.includes("@{")) return `${what} cannot contain "@{"`;
  return "";
}

/** Why `name` cannot be a new branch in this repo; "" when it can. */
export async function checkBranchName(run: GitRun, root: string, name: unknown): Promise<string> {
  const error = refInputError(name, "branch");
  if (error !== "") return error;
  const branch = String(name).trim();
  if ((await run(["check-ref-format", "--branch", branch], root)).code !== 0) return `branch ${branch} is not a valid branch name`;
  if ((await run(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root)).code === 0) return `branch ${branch} already exists`;
  return "";
}

/** Full commit sha for `ref`, or why it cannot be a base commit. */
export async function resolveBase(run: GitRun, root: string, ref: unknown): Promise<{ sha: string; error?: undefined } | { error: string; sha?: undefined }> {
  const error = refInputError(ref, "base");
  if (error !== "") return { error };
  const name = String(ref).trim();
  const res = await run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${name}^{commit}`], root);
  const sha = res.stdout.trim();
  if (!FULL_SHA.test(sha)) return { error: `base ${name} is not a commit here` };
  return { sha };
}

/** The registered worktree `path` points at, or why it is not one of this project's worktrees. */
export async function checkWorktreePath(run: GitRun, root: string, path: unknown): Promise<{ path: string; error?: undefined } | { error: string; path?: undefined }> {
  if (typeof path !== "string" || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) return { error: NOT_A_WORKTREE };
  const listing = await run(["worktree", "list", "--porcelain"], root);
  for (const rec of parseWorktreeList(listing.stdout).slice(1)) {
    if (!rec.prunable && resolve(path) === resolve(rec.path)) return { path: rec.path };
  }
  return { error: NOT_A_WORKTREE };
}

/** A start's picked base, branch and existing worktree path, as the caller sent them. */
export type WorktreePick = { base?: unknown; branch?: unknown; worktreePath?: unknown };

/** A new worktree's base sha and branch name, each only when picked. */
type NewWorktree = { base?: string; branch?: string };

/** What a worktree start targets: an existing worktree, or a base sha and a new branch name. */
export async function worktreeTarget(run: GitRun, root: string, { base, branch, worktreePath }: { base?: unknown; branch?: unknown; worktreePath?: unknown }): Promise<{ existing: string; error?: undefined } | { base?: string; branch?: string; existing?: undefined; error?: undefined } | { error: string }> {
  if (given(worktreePath)) {
    if (given(base) || given(branch)) return { error: "pick an existing worktree or a base, not both" };
    const found = await checkWorktreePath(run, root, worktreePath);
    return found.error !== undefined ? { error: found.error } : { existing: found.path };
  }
  const target: NewWorktree = {};
  if (given(base)) {
    const resolved = await resolveBase(run, root, base);
    if (resolved.error !== undefined) return { error: resolved.error };
    target.base = resolved.sha;
  }
  if (given(branch)) {
    const error = await checkBranchName(run, root, branch);
    if (error !== "") return { error };
    target.branch = String(branch).trim();
  }
  return target;
}

/** worktreeTarget against the project's git; {} when nothing was picked, so a plain start needs no git lookup. */
export async function pickedWorktree(root: string, pick: WorktreePick = {}, env: NodeJS.ProcessEnv = process.env): Promise<{ existing?: string; base?: string; branch?: string; error?: string }> {
  if (!given(pick.base) && !given(pick.branch) && !given(pick.worktreePath)) return {};
  const gitFile = findExecutable("git", env.PATH);
  if (!gitFile) return { error: "git is not installed" };
  return worktreeTarget(gitRunner(gitFile, env), root, pick);
}

/** One GitHub pull request as the picker needs it; base is null when this repo cannot check it out. */
export type PrHead = { number: number; title: string; head: string; base: string | null };

/** PR title, head branch, and a base this repo can check out; null when gh fails or the number is out of range. */
export async function prHead(ghFile: string, run: GitRun, root: string, number: number, env: NodeJS.ProcessEnv): Promise<PrHead | null> {
  if (!Number.isSafeInteger(number) || number < 1 || number > 9_999_999) return null;
  let data: unknown;
  try {
    const stdout = await new Promise<string>((ok, fail) => {
      execFile(ghFile, ["pr", "view", String(number), "--json", "number,title,headRefName,headRefOid,isCrossRepository"], { cwd: root, env, shell: false, timeout: 10_000, encoding: "utf8" }, (error, out) => (error ? fail(error) : ok(out)));
    });
    data = JSON.parse(stdout);
  } catch { return null; }
  const { title, headRefName, headRefOid, isCrossRepository } = (data ?? {}) as Record<string, unknown>;
  if (typeof title !== "string" || typeof headRefName !== "string" || typeof headRefOid !== "string" || !FULL_SHA.test(headRefOid)) return null;
  let base: string | null = null;
  if ((await run(["cat-file", "-e", `${headRefOid}^{commit}`], root)).code === 0) base = headRefOid;
  else if (isCrossRepository !== true && (await run(["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/remotes/origin/${headRefName}^{commit}`], root)).code === 0) base = `origin/${headRefName}`;
  return { number, title, head: headRefName, base };
}
