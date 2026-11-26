/** `ai-collab prune`: reclaim disk from settled builder copies and git worktrees; keeps every commit reachable. */
import { execFile } from "node:child_process";
import { parseArgs } from "node:util";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { builderPaths, FINAL_PHASES, LIVE_STATES } from "./builder/state.ts";
import { unitState } from "./builder/supervisor.ts";
import { PROTECTED_CHECKOUTS } from "./builder-clean.ts";
import { stateDir } from "./config.mjs";
import { sessionRecords } from "./sessions/registry.ts";
import { projectRoot } from "./start.mjs";
import { openTasks, TaskNotFoundError } from "./tasks.mjs";

export const ARCHIVE_NS = "refs/ai-collab/archive";
export const LOG_CAP_BYTES = 1024 * 1024;
const MIN_CUTOFF_MS = 24 * 3_600_000;
const SCAN_MAX_ENTRIES = 50_000;
const SCAN_SKIP = new Set([".git", "node_modules"]);
const ALLOWED_IGNORED = [/^node_modules(\/|$)/, /^web\/\.next/];
const LOCK_REASON = "ai-collab prune";
const AGE_UNITS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const GIT_ENV_KEYS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"];
const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const USAGE = "usage: ai-collab prune [--apply] [--older-than 7d] [--json]   (cutoff at least 24h)";

/** Milliseconds for "7d", "24h", "30m" or "45s"; null for anything else. */
export function parseAge(text) {
  const match = /^(\d+)([smhd])$/.exec(text ?? "");
  return match ? Number(match[1]) * AGE_UNITS[match[2]] : null;
}

/** Flags for prune, or null for an unknown flag, a bad age, or a cutoff under 24h. */
export function parsePruneArgs(argv) {
  let flags;
  try {
    ({ values: flags } = parseArgs({ args: argv, strict: true, options: {
      apply: { type: "boolean", default: false }, json: { type: "boolean", default: false }, "older-than": { type: "string", default: "7d" },
    } }));
  } catch { return null; }
  const { apply, json, "older-than": olderThan } = flags;
  const olderThanMs = parseAge(olderThan);
  return olderThanMs === null || olderThanMs < MIN_CUTOFF_MS ? null : { apply, json, olderThan, olderThanMs };
}

/** Records from `git worktree list --porcelain`; the first record is the main worktree. */
export function parseWorktreeList(text) {
  const rows = [];
  let row = null;
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

/** Bytes of disk the tree at `target` uses; an inode counts once. */
export function treeBytes(target, seen = new Set()) {
  let info;
  try { info = lstatSync(target); } catch { return 0; }
  const key = `${info.dev}:${info.ino}`;
  if (seen.has(key)) return 0;
  seen.add(key);
  let total = info.blocks * 512;
  if (info.isDirectory() && !info.isSymbolicLink()) {
    for (const name of readdirSync(target)) total += treeBytes(path.join(target, name), seen);
  }
  return total;
}

/** Working directories of the processes in /proc; an unreadable cwd is not counted. */
export function readLiveCwds(proc = "/proc") {
  let pids;
  try { pids = readdirSync(proc).filter((pid) => /^\d+$/.test(pid)); } catch { return []; }
  const cwds = [];
  for (const pid of pids) {
    try { cwds.push(readlinkSync(path.join(proc, pid, "cwd"))); } catch { /* exited, kernel thread, or not readable */ }
  }
  return cwds;
}

/** True when `wtPath` is the project checkout or a protected checkout, not a path inside one. */
export function isProtectedCheckout(wtPath, root) {
  const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
  const target = real(wtPath);
  return [root, ...PROTECTED_CHECKOUTS].some((base) => real(base) === target);
}

/** Bulky copies in one builder dir: clone, staged trees (with tools), sandbox downloads, and logs over the cap. */
export function builderBulkTargets(dir) {
  const targets = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "back") targets.push({ kind: "clone", path: full });
    else if (name === "stage") targets.push({ kind: "staged", path: full });
    else if (name.startsWith("download-")) targets.push({ kind: "downloads", path: full });
    else if (name.endsWith(".log")) {
      const info = lstatSync(full);
      if (info.isFile() && info.size > LOG_CAP_BYTES) targets.push({ kind: "logs", path: full });
    }
  }
  return targets;
}

/** Newest file mtime under `root`, skipping node_modules and .next; Infinity when the scan hits its entry cap. */
export function newestFileMs(root, maxEntries = SCAN_MAX_ENTRIES) {
  let newest = 0;
  let seen = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (SCAN_SKIP.has(name) || name.startsWith(".next")) continue;
      seen += 1;
      if (seen > maxEntries) return Infinity;
      const full = path.join(dir, name);
      let info;
      try { info = lstatSync(full); } catch { continue; }
      if (info.isDirectory()) stack.push(full);
      else newest = Math.max(newest, info.mtimeMs);
    }
  }
  return newest;
}

/** True when an ignored path is one a rebuild recreates (node_modules, web/.next*, dist). */
export function isAllowedIgnored(file) {
  return ALLOWED_IGNORED.some((pattern) => pattern.test(file));
}

/** Decide one worktree from its facts. Pure: no I/O. */
export function worktreeDecision(f, cutoffMs) {
  const keep = (reason) => ({ action: "keep", reason, archive: null });
  if (f.main) return keep("main worktree");
  if (f.protected) return keep("protected checkout");
  if (f.locked) return keep("locked");
  if (f.nested) return keep(`contains another worktree: ${f.nested}`);
  if (f.error) return keep(`unreadable: ${f.error}`);
  if (f.dirty > 0) return keep(`dirty: ${f.dirty} changed or untracked file(s)`);
  if (f.ignoredBad?.length) return keep(`ignored outside allowlist: ${f.ignoredBad[0]}`);
  if (f.reflogOnly?.length) return keep("HEAD reflog holds commits on no ref");
  if (f.inUse) return keep("in use: a live process has its cwd inside");
  if (f.builderOpen) return keep("builder task open");
  if (f.lastActivityMs >= cutoffMs) return keep("newer than cutoff");
  if (f.detached && f.archiveSha && f.archiveSha !== f.head) return keep("archive ref points elsewhere");
  const archive = f.detached && !f.archiveSha ? { ref: f.archiveRef, sha: f.head } : null;
  const reason = f.detached ? "detached" : "clean";
  return { action: f.prunable ? "prune" : "remove", reason: f.prunable ? "directory missing" : reason, archive };
}

/** Decide one builder dir from its facts. Pure: no I/O. */
export function builderDecision(f, cutoffMs) {
  const keep = (reason) => ({ action: "keep", reason, archive: null });
  if (f.error) return keep(`unreadable: ${f.error}`);
  if (!FINAL_PHASES.includes(f.phase)) return keep(`unsettled: ${f.phase}`);
  if (LIVE_STATES.includes(f.unitActive) || f.unitActive === "unknown") return keep(`unit ${f.unitActive}`);
  if (f.pidAlive) return keep("process alive");
  if (f.taskOpen) return keep("task open");
  if (f.mtimeMs >= cutoffMs) return keep("newer than cutoff");
  let archive = null;
  if (f.backExists) {
    if (!f.root) return keep("unpreserved commits: no project root");
    if (f.archiveDiverged) return keep("archive ref differs from clone");
    if (f.backIgnoredBad?.length) return keep(`ignored outside node_modules: ${f.backIgnoredBad[0]}`);
    archive = { id: f.id, backRepo: f.backRepo };
  } else if (f.commits > 0 && !f.landed && !f.archiveHead) {
    return keep("unpreserved commits: no clone");
  }
  if (f.bytes === 0 && !archive) return keep("nothing to reclaim");
  return { action: "remove", reason: f.phase, archive };
}

function gitEnv(env) {
  const next = { ...env };
  for (const key of GIT_ENV_KEYS) delete next[key];
  return next;
}

function runGit(cwd, args, env) {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { env: gitEnv(env), timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stderr }));
        return;
      }
      resolve(stdout);
    });
  });
}

async function revParse(cwd, ref, env) {
  try {
    return (await runGit(cwd, ["rev-parse", "--verify", "--quiet", ref], env)).trim() || null;
  } catch {
    return null;
  }
}

async function isAncestor(cwd, older, newer, env) {
  try {
    await runGit(cwd, ["merge-base", "--is-ancestor", older, newer], env);
    return true;
  } catch {
    return false;
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); } catch (error) { return error.code !== "ESRCH"; }
  return true;
}

function oneLine(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function builderIds(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((id) => {
    if (id === "." || id === ".." || id !== path.basename(id) || id.includes("\0")) return false;
    try { return lstatSync(path.join(root, id)).isDirectory(); } catch { return false; }
  });
}

/** True while a builder's task is open: unknown tasks are closed, an unreadable store is open. */
export function taskIsOpen(state, env) {
  if (typeof state.task !== "string" || typeof state.project !== "string") return false;
  try {
    const task = openTasks(state.project, env).get(state.task);
    return task.status !== "done";
  } catch (error) {
    return !(error instanceof TaskNotFoundError);
  }
}

// Where node_modules sits at the worktree top: "link", "dir", "file" or "none".
function nodeModulesKind(wtPath) {
  try {
    const info = lstatSync(path.join(wtPath, "node_modules"));
    if (info.isSymbolicLink()) return "link";
    return info.isDirectory() ? "dir" : "file";
  } catch {
    return "none";
  }
}

/** Reads a builder's state and facts. Pure apart from the reads. */
async function gatherBuilder(id, ctx) {
  const { env } = ctx;
  const paths = builderPaths(id, env);
  const f = { id, error: "", phase: "", commits: 0, landed: false, root: null, mtimeMs: 0, unitActive: "", pidAlive: false,
    taskOpen: false, bulk: [], bytes: 0, worktree: "", backExists: false, backRepo: "", backSha: null, archiveHead: null, archiveDiverged: false };
  let state;
  try {
    state = JSON.parse(readFileSync(paths.state, "utf8"));
    f.mtimeMs = statSync(paths.state).mtimeMs;
  } catch {
    f.error = "state.json unreadable";
    return f;
  }
  f.phase = state.phase;
  f.commits = state.commits ?? 0;
  f.landed = Boolean(state.landed);
  f.root = typeof state.root === "string" ? state.root : null;
  f.worktree = typeof state.worktree === "string" ? state.worktree : "";
  f.unitActive = await unitState(paths.unit, env);
  f.pidAlive = Number.isSafeInteger(state.pid) && state.pid > 0 && isAlive(state.pid);
  f.taskOpen = ctx.taskOpen(state);
  f.bulk = builderBulkTargets(paths.dir).map((target) => ({ ...target, bytes: treeBytes(target.path) }));
  f.bytes = f.bulk.reduce((sum, target) => sum + target.bytes, 0);
  if (f.worktree) {
    f.backRepo = path.join(paths.dir, "back", path.basename(f.worktree));
    f.backExists = existsSync(path.join(f.backRepo, ".git"));
  }
  if (f.backExists) {
    try {
      const lines = (await runGit(f.backRepo, ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all", "--ignored=matching"], env))
        .split("\n").filter(Boolean);
      f.backIgnoredBad = lines.filter((line) => line.startsWith("!! ")).map((line) => line.slice(3))
        .filter((file) => !/^node_modules(\/|$)/.test(file));
    } catch (error) {
      f.error = oneLine(error.stderr || error.message);
    }
  }
  if (f.backExists && f.root) {
    f.backSha = await revParse(f.backRepo, "HEAD", env);
    f.archiveHead = await revParse(f.root, `${ARCHIVE_NS}/${id}/HEAD`, env);
    f.archiveDiverged = Boolean(f.archiveHead && f.backSha && !(await isAncestor(f.root, f.archiveHead, f.backSha, env)));
  } else if (f.root) {
    f.archiveHead = await revParse(f.root, `${ARCHIVE_NS}/${id}/HEAD`, env);
  }
  return f;
}

/** Commits in the worktree's HEAD reflog (other than HEAD) that no ref reaches. */
async function reflogOnlyCommits(root, admin, head, env) {
  if (!admin) return [];
  const log = path.join(admin, "logs", "HEAD");
  if (!existsSync(log)) return [];
  const shas = new Set();
  for (const line of readFileSync(log, "utf8").split("\n")) {
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) /.exec(line);
    if (match) shas.add(match[2]);
  }
  shas.delete(head);
  shas.delete("0".repeat(40));
  if (!shas.size) return [];
  return (await runGit(root, ["rev-list", ...shas, "--not", "--all"], env)).split("\n").filter(Boolean);
}

async function adminDirOf(wt, root, env) {
  if (wt.prunable) {
    const common = (await runGit(root, ["rev-parse", "--git-common-dir"], env)).trim();
    return path.join(path.resolve(root, common), "worktrees", path.basename(wt.path));
  }
  try {
    return (await runGit(wt.path, ["rev-parse", "--absolute-git-dir"], env)).trim();
  } catch {
    return null;
  }
}

// Newest of: HEAD commit, directory and file mtimes, index, HEAD reflog, and any session seen inside.
async function activityMs(wt, admin, ctx) {
  const times = [0];
  if (wt.head) {
    try { times.push(Number((await runGit(ctx.root, ["log", "-1", "--format=%ct", wt.head], ctx.env)).trim() || 0) * 1000); } catch { times.push(Infinity); }
  }
  if (existsSync(wt.path)) times.push(statSync(wt.path).mtimeMs, newestFileMs(wt.path));
  if (admin && existsSync(path.join(admin, "index"))) times.push(statSync(path.join(admin, "index")).mtimeMs);
  if (admin && existsSync(path.join(admin, "logs", "HEAD"))) {
    for (const match of readFileSync(path.join(admin, "logs", "HEAD"), "utf8").matchAll(/ (\d{9,11}) [+-]\d{4}\t/g)) times.push(Number(match[1]) * 1000);
  }
  for (const session of ctx.sessions()) {
    if (session.unreadable) times.push(Infinity);
    const inside = session.cwd === wt.path || session.cwd?.startsWith(wt.path + path.sep);
    if (inside) times.push(session.live ? Infinity : session.seenAt ?? Infinity);
  }
  return Math.max(...times);
}

/** Reads one worktree's facts. Pure apart from the reads. */
async function gatherWorktree(wt, index, worktrees, ctx) {
  const { env, root } = ctx;
  const f = { main: index === 0, protected: isProtectedCheckout(wt.path, root), locked: wt.locked, prunable: wt.prunable,
    detached: wt.detached, head: wt.head, path: wt.path, error: "", dirty: 0, ignoredBad: [], reflogOnly: [], inUse: false,
    builderOpen: ctx.builderWorktrees.has(wt.path), nested: "", lastActivityMs: Infinity,
    archiveRef: `${ARCHIVE_NS}/wt-${path.basename(wt.path)}`, archiveSha: null };
  f.nested = worktrees.filter((other) => other.path !== wt.path && other.path.startsWith(wt.path + path.sep))
    .map((other) => path.basename(other.path))[0] ?? "";
  if (f.main) return f;
  const cwds = ctx.liveCwds();
  f.inUse = cwds.some((cwd) => cwd === wt.path || cwd.startsWith(wt.path + path.sep));
  const admin = await adminDirOf(wt, root, env);
  try {
    if (!wt.prunable) {
      const lines = (await runGit(wt.path, ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all", "--ignored=matching"], env))
        .split("\n").filter(Boolean);
      const ignored = lines.filter((line) => line.startsWith("!! ")).map((line) => line.slice(3));
      const tracked = lines.filter((line) => !line.startsWith("!! "));
      const linkOnly = nodeModulesKind(wt.path) === "link" && tracked.filter((line) => line === "?? node_modules").length === 1;
      f.dirty = tracked.length - (linkOnly ? 1 : 0);
      f.ignoredBad = ignored.filter((file) => !isAllowedIgnored(file));
    }
    f.reflogOnly = await reflogOnlyCommits(root, admin, wt.head, env);
    f.lastActivityMs = await activityMs(wt, admin, ctx);
  } catch (error) {
    f.error = oneLine(error.stderr || error.message);
  }
  if (wt.detached) f.archiveSha = await revParse(root, f.archiveRef, env);
  return f;
}

// Archives a builder's clone: commits uncommitted work, then copies every branch and HEAD into the project repo.
async function archiveBuilder(archive, ctx) {
  const ref = `${ARCHIVE_NS}/${archive.id}`;
  if ((await runGit(archive.backRepo, ["status", "--porcelain"], ctx.env)).trim()) {
    await runGit(archive.backRepo, ["add", "-A", "--", ".", ":!node_modules"], ctx.env);
    await runGit(archive.backRepo, ["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "prune: archive uncommitted work"], ctx.env);
  }
  const sha = (await runGit(archive.backRepo, ["rev-parse", "HEAD"], ctx.env)).trim();
  const refspecs = [`refs/heads/*:${ref}/heads/*`, `refs/tags/*:${ref}/tags/*`, `HEAD:${ref}/HEAD`];
  if (await revParse(archive.backRepo, "refs/stash", ctx.env)) refspecs.push(`refs/stash:${ref}/stash`);
  await runGit(ctx.root, ["fetch", "--quiet", "--no-tags", archive.backRepo, ...refspecs], ctx.env);
  if (await revParse(ctx.root, `${ref}/HEAD`, ctx.env) !== sha) throw new Error(`could not verify ${ref}/HEAD`);
  return { ref: `${ref}/HEAD`, sha };
}

async function setRef(root, ref, sha, env) {
  await runGit(root, ["update-ref", ref, sha], env);
  if (await revParse(root, ref, env) !== sha) throw new Error(`could not verify ${ref}`);
}

function removeTargets(dir, targets) {
  for (const target of targets) {
    if (path.dirname(target.path) !== dir) throw new Error(`refusing to remove ${target.path}`);
    rmSync(target.path, { recursive: true, force: true });
  }
}

// Removes the worktree. A refused removal unlinks only its node_modules symlink, then retries; a failed retry restores the link.
async function removeWorktree(root, wtPath, env) {
  try {
    await runGit(root, ["worktree", "remove", wtPath], env);
  } catch (error) {
    const link = path.join(wtPath, "node_modules");
    if (nodeModulesKind(wtPath) !== "link") throw error;
    const target = readlinkSync(link);
    unlinkSync(link);
    try {
      await runGit(root, ["worktree", "remove", wtPath], env);
    } catch (retryError) {
      symlinkSync(target, link);
      throw retryError;
    }
  }
}

function addCategory(categories, kind, bytes) {
  const entry = categories[kind] ?? { count: 0, bytes: 0 };
  categories[kind] = { count: entry.count + 1, bytes: entry.bytes + bytes };
}

/** Plan (and with `apply`, carry out) the prune for one repo and its builder state. */
export async function pruneRepo({ env, root, olderThanMs, apply, now = Date.now(), cwds = readLiveCwds, sessions = () => [],
  taskOpen = (state) => taskIsOpen(state, env) }) {
  if (olderThanMs < MIN_CUTOFF_MS) throw new Error("cutoff must be at least 24h");
  const cutoffMs = now - olderThanMs;
  const liveCwds = () => (typeof cwds === "function" ? cwds() : cwds);
  const ctx = { env, root, liveCwds, sessions, taskOpen, builderWorktrees: new Set() };
  const summary = { mode: apply ? "apply" : "dry-run", cutoff: new Date(cutoffMs).toISOString(), reclaimedBytes: 0,
    categories: {}, builders: [], worktrees: [], archives: [], skipped: [], skipReasons: {} };
  const skip = (kind, key, reason) => summary.skipped.push({ kind, key, reason });

  const buildersRoot = path.join(stateDir(env), "builders");
  const builders = [];
  for (const id of builderIds(buildersRoot)) builders.push(await gatherBuilder(id, ctx));
  ctx.builderWorktrees = new Set(builders.filter((f) => f.taskOpen && f.worktree).map((f) => f.worktree));
  for (const f of builders) {
    const decision = builderDecision(f, cutoffMs);
    if (decision.action === "keep") {
      skip("builder", f.id, decision.reason);
      continue;
    }
    let current = f;
    let archived = null;
    try {
      if (apply) {
        current = await gatherBuilder(f.id, ctx);
        const again = builderDecision(current, cutoffMs);
        if (again.action !== "remove") {
          skip("builder", f.id, again.reason);
          continue;
        }
        if (again.archive) archived = await archiveBuilder(again.archive, ctx);
        removeTargets(builderPaths(f.id, env).dir, current.bulk);
      } else if (decision.archive) {
        archived = { ref: `${ARCHIVE_NS}/${f.id}/HEAD`, sha: f.backSha };
      }
    } catch (error) {
      skip("builder", f.id, `remove failed: ${oneLine(error.message)}`);
      continue;
    }
    if (archived) summary.archives.push({ ref: archived.ref, sha: archived.sha, source: f.id });
    for (const target of current.bulk) addCategory(summary.categories, target.kind, target.bytes);
    summary.builders.push({ id: f.id, phase: f.phase, bytes: f.bytes, targets: f.bulk.map((t) => t.kind) });
    summary.reclaimedBytes += f.bytes;
  }

  const worktrees = parseWorktreeList(await runGit(root, ["worktree", "list", "--porcelain"], env));
  const keptPrunable = [];
  for (const [index, wt] of worktrees.entries()) {
    const f = await gatherWorktree(wt, index, worktrees, ctx);
    const decision = worktreeDecision(f, cutoffMs);
    if (decision.action === "keep") {
      skip("worktree", wt.path, decision.reason);
      if (wt.prunable && !wt.locked) keptPrunable.push(wt.path);
      continue;
    }
    const bytes = existsSync(wt.path) ? treeBytes(wt.path) : 0;
    try {
      if (apply && decision.action === "remove") {
        const verdict = await lockedRecheck(wt, index, worktrees, ctx, cutoffMs);
        if (verdict.action !== "remove") {
          skip("worktree", wt.path, verdict.reason);
          continue;
        }
        await removeWorktree(root, wt.path, env);
      } else if (apply && decision.archive) {
        await setRef(root, decision.archive.ref, decision.archive.sha, env);
      }
    } catch (error) {
      skip("worktree", wt.path, `remove failed: ${oneLine(error.stderr || error.message)}`);
      continue;
    }
    if (decision.archive) summary.archives.push({ ref: decision.archive.ref, sha: decision.archive.sha, source: wt.path });
    if (decision.action === "remove") addCategory(summary.categories, "worktrees", bytes);
    summary.worktrees.push({ path: wt.path, branch: wt.branch, detached: wt.detached, bytes: decision.action === "remove" ? bytes : 0, action: decision.action });
    summary.reclaimedBytes += decision.action === "remove" ? bytes : 0;
  }
  if (apply) await pruneEntries(root, keptPrunable, env);
  for (const item of summary.skipped) {
    const key = item.reason.split(":")[0];
    summary.skipReasons[key] = (summary.skipReasons[key] ?? 0) + 1;
  }
  return summary;
}

// Re-reads every rule under a lock; the lock is released on every path, including a failed archive.
async function lockedRecheck(wt, index, worktrees, ctx, cutoffMs) {
  const { env, root } = ctx;
  await runGit(root, ["worktree", "lock", "--reason", LOCK_REASON, wt.path], env);
  let verdict;
  try {
    verdict = worktreeDecision(await gatherWorktree(wt, index, worktrees, ctx), cutoffMs);
    if (verdict.action === "remove" && verdict.archive) await setRef(root, verdict.archive.ref, verdict.archive.sha, env);
  } finally {
    await runGit(root, ["worktree", "unlock", wt.path], env);
  }
  return verdict;
}

// Removes the admin entries of missing worktrees that were chosen; locks the kept ones so git leaves them.
async function pruneEntries(root, keptPrunable, env) {
  for (const kept of keptPrunable) await runGit(root, ["worktree", "lock", "--reason", LOCK_REASON, kept], env);
  await runGit(root, ["worktree", "prune"], env);
  for (const kept of keptPrunable) await runGit(root, ["worktree", "unlock", kept], env);
}

function formatBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  return `${bytes} B`;
}

/** One line for logs and schedule records: mode, bytes, counts, and the three most common skip reasons. */
export function summaryLine(summary) {
  const mode = summary.mode === "apply" ? "applied" : "dry run";
  const verb = summary.mode === "apply" ? "reclaimed" : "reclaimable";
  const categories = Object.entries(summary.categories).map(([kind, entry]) => `${kind} ${entry.count}`).join(", ");
  const top = Object.entries(summary.skipReasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason, count]) => `${reason} ${count}`).join(", ");
  const removed = summary.worktrees.filter((w) => w.action === "remove").length;
  return `prune ${mode}: ${verb} ${formatBytes(summary.reclaimedBytes)}; builders ${summary.builders.length}`
    + `${categories ? ` (${categories})` : ""}; worktrees ${removed}; archives ${summary.archives.length}`
    + `; skipped ${summary.skipped.length}${top ? ` (${top})` : ""}`;
}

/** Human-readable report for `prune`. */
export function renderPrune(summary) {
  const lines = [
    summary.mode === "apply" ? "prune: applied" : "prune: dry run, nothing deleted (pass --apply to delete)",
    `cutoff ${summary.cutoff}`,
    `builders: ${summary.builders.length} to prune`,
  ];
  for (const [kind, entry] of Object.entries(summary.categories)) lines.push(`  ${kind}: ${entry.count} (${formatBytes(entry.bytes)})`);
  lines.push(`worktrees: ${summary.worktrees.filter((w) => w.action === "remove").length} to remove`);
  lines.push(`archive refs: ${summary.archives.length}`);
  lines.push(`reclaimable: ${formatBytes(summary.reclaimedBytes)}`);
  lines.push(`skipped: ${summary.skipped.length}`);
  for (const [reason, count] of Object.entries(summary.skipReasons)) lines.push(`  ${reason}: ${count}`);
  for (const item of summary.skipped) lines.push(`  ${item.kind} ${item.key}: ${item.reason}`);
  return `${lines.join("\n")}\n`;
}

/** `ai-collab prune [--apply] [--older-than 7d] [--json]`. */
export async function prune(argv, { env, cfg, out, err }) {
  const flags = parsePruneArgs(argv);
  if (!flags) {
    err.write(`ai-collab: ${USAGE}\n`);
    return 2;
  }
  try {
    const root = projectRoot(cfg.project, env);
    const summary = await pruneRepo({ env, root, olderThanMs: flags.olderThanMs, apply: flags.apply, sessions: () => sessionRecords(cfg) });
    out.write(flags.json ? `${JSON.stringify(summary, null, 2)}\n` : renderPrune(summary));
    err.write(`${summaryLine(summary)}\n`);
    return 0;
  } catch (error) {
    err.write(`ai-collab: prune: ${error.message}\n`);
    return 1;
  }
}
