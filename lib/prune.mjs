/** `ai-collab prune`: reclaim disk from settled builder copies and git worktrees; keeps every commit reachable. */
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { builderPaths, FINAL_PHASES, LIVE_STATES } from "./builder/state.mjs";
import { unitState } from "./builder/supervisor.mjs";
import { PROTECTED_CHECKOUTS } from "./builder-clean.mjs";
import { stateDir } from "./config.mjs";
import { projectRoot } from "./start.mjs";

export const ARCHIVE_NS = "refs/ai-collab/archive";
export const LOG_CAP_BYTES = 1024 * 1024;
const AGE_UNITS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const GIT_ENV_KEYS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"];
const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const USAGE = "usage: ai-collab prune [--apply] [--older-than 7d] [--json]";

/** Milliseconds for "7d", "12h", "30m" or "45s"; null for anything else. */
export function parseAge(text) {
  const match = /^(\d+)([smhd])$/.exec(text ?? "");
  return match ? Number(match[1]) * AGE_UNITS[match[2]] : null;
}

/** Flags for prune, or null when argv has an unknown flag or a bad age. */
export function parsePruneArgs(argv) {
  const flags = { apply: false, json: false, olderThan: "7d" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") flags.apply = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--older-than") flags.olderThan = argv[++i];
    else return null;
  }
  const olderThanMs = parseAge(flags.olderThan);
  return olderThanMs === null ? null : { ...flags, olderThanMs };
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

/** True when `wtPath` is the project checkout or a protected checkout, not a path inside one. */
export function isProtectedCheckout(wtPath, root) {
  const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
  const target = real(wtPath);
  return [root, ...PROTECTED_CHECKOUTS].some((base) => real(base) === target);
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

/** Pids' working directories from /proc; a process whose cwd is unreadable is not counted. */
export function readLiveCwds(proc = "/proc") {
  let pids;
  try { pids = readdirSync(proc).filter((pid) => /^\d+$/.test(pid)); } catch { return []; }
  const cwds = [];
  for (const pid of pids) {
    try { cwds.push(readlinkSync(path.join(proc, pid, "cwd"))); } catch { /* exited, kernel thread, or not readable */ }
  }
  return cwds;
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

/** Decide one worktree from its facts. Pure: no I/O. */
export function worktreeDecision(f, cutoffMs) {
  const keep = (reason) => ({ action: "keep", reason, archive: null });
  if (f.main) return keep("main worktree");
  if (f.protected) return keep("protected checkout");
  if (f.locked) return keep("locked");
  if (f.prunable) return { action: "prune", reason: "directory missing", archive: null };
  if (f.error) return keep(`unreadable: ${f.error}`);
  if (f.dirty > 0) return keep(`dirty: ${f.dirty} changed or untracked file(s)`);
  if (f.inUse) return keep("in use: a live process has its cwd inside");
  if (f.lastActivityMs >= cutoffMs) return keep("newer than cutoff");
  if (!f.detached) return { action: "remove", reason: "clean", archive: null };
  if (f.archiveSha === f.head) return { action: "remove", reason: "detached, archived", archive: null };
  if (f.archiveSha) return keep("archive ref points elsewhere");
  return { action: "remove", reason: "detached", archive: { ref: f.archiveRef, sha: f.head } };
}

/** Decide one builder dir from its facts. Pure: no I/O. */
export function builderDecision(f, cutoffMs) {
  const keep = (reason) => ({ action: "keep", reason, archive: null });
  if (f.error) return keep(`unreadable: ${f.error}`);
  if (!FINAL_PHASES.includes(f.phase)) return keep(`unsettled: ${f.phase}`);
  if (LIVE_STATES.includes(f.unitActive) || f.unitActive === "unknown") return keep(`unit ${f.unitActive}`);
  if (f.pidAlive) return keep("process alive");
  if (f.mtimeMs >= cutoffMs) return keep("newer than cutoff");
  let archive = null;
  if (f.commits > 0 && !f.landed) {
    if (!f.root) return keep("unpreserved commits: no project root");
    if (f.archiveSha && f.backSha && f.archiveSha !== f.backSha) return keep("archive ref differs from clone");
    if (!f.archiveSha && !f.backSha) return keep("unpreserved commits: no clone");
    if (!f.archiveSha) archive = { ref: f.archiveRef, sha: f.backSha };
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

async function gatherBuilder(id, env) {
  const paths = builderPaths(id, env);
  const f = { id, error: "", phase: "", commits: 0, landed: false, root: null, mtimeMs: 0, unitActive: "", pidAlive: false,
    bulk: [], bytes: 0, backSha: null, archiveRef: `${ARCHIVE_NS}/${id}`, archiveSha: null };
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
  f.unitActive = await unitState(paths.unit, env);
  f.pidAlive = Number.isSafeInteger(state.pid) && state.pid > 0 && isAlive(state.pid);
  f.bulk = builderBulkTargets(paths.dir).map((target) => ({ ...target, bytes: treeBytes(target.path) }));
  f.bytes = f.bulk.reduce((sum, target) => sum + target.bytes, 0);
  if (typeof state.worktree === "string") {
    const backRepo = path.join(paths.dir, "back", path.basename(state.worktree));
    f.backRepo = backRepo;
    if (existsSync(path.join(backRepo, ".git"))) f.backSha = await revParse(backRepo, "HEAD", env);
  }
  if (f.root) f.archiveSha = await revParse(f.root, f.archiveRef, env);
  return f;
}

async function gatherWorktree(wt, index, { root, cwds, env }) {
  const name = path.basename(wt.path);
  const f = { main: index === 0, protected: isProtectedCheckout(wt.path, root), locked: wt.locked, prunable: wt.prunable,
    detached: wt.detached, head: wt.head, path: wt.path, branch: wt.branch, dirty: 0, error: "", lastActivityMs: null,
    inUse: false, archiveRef: `${ARCHIVE_NS}/wt-${name}`, archiveSha: null };
  if (!f.main && !f.prunable) {
    try {
      f.dirty = (await runGit(wt.path, ["status", "--porcelain", "--untracked-files=all"], env)).split("\n").filter(Boolean).length;
      const committed = (await runGit(wt.path, ["log", "-1", "--format=%ct"], env)).trim();
      f.lastActivityMs = Math.max(committed ? Number(committed) * 1000 : 0, statSync(wt.path).mtimeMs);
    } catch (error) {
      f.error = oneLine(error.stderr || error.message);
    }
  }
  const real = existsSync(wt.path) ? realpathSync(wt.path) : wt.path;
  f.inUse = cwds.some((cwd) => [wt.path, real].some((base) => cwd === base || cwd.startsWith(base + path.sep)));
  if (wt.detached) f.archiveSha = await revParse(root, f.archiveRef, env);
  return f;
}

async function archiveBuilder(root, archive, backRepo, env) {
  await runGit(root, ["fetch", "--quiet", "--no-tags", backRepo, `HEAD:${archive.ref}`], env);
  if (await revParse(root, archive.ref, env) !== archive.sha) throw new Error(`could not verify ${archive.ref}`);
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

function addCategory(categories, kind, bytes) {
  const entry = categories[kind] ?? { count: 0, bytes: 0 };
  categories[kind] = { count: entry.count + 1, bytes: entry.bytes + bytes };
}

/** Plan (and with `apply`, carry out) the prune for one repo and its builder state. */
export async function pruneRepo({ env, root, olderThanMs, apply, now = Date.now(), cwds = readLiveCwds() }) {
  const cutoffMs = now - olderThanMs;
  const summary = { mode: apply ? "apply" : "dry-run", cutoff: new Date(cutoffMs).toISOString(), reclaimedBytes: 0,
    categories: {}, builders: [], worktrees: [], archives: [], skipped: [], skipReasons: {} };
  const skip = (kind, key, reason) => summary.skipped.push({ kind, key, reason });
  const buildersRoot = path.join(stateDir(env), "builders");
  for (const id of builderIds(buildersRoot)) {
    const f = await gatherBuilder(id, env);
    const decision = builderDecision(f, cutoffMs);
    if (decision.action === "keep") {
      skip("builder", id, decision.reason);
      continue;
    }
    try {
      if (decision.archive) {
        if (apply) await archiveBuilder(f.root, decision.archive, f.backRepo, env);
        summary.archives.push({ ref: decision.archive.ref, sha: decision.archive.sha, source: id });
      }
      if (apply) removeTargets(builderPaths(id, env).dir, f.bulk);
    } catch (error) {
      skip("builder", id, `archive failed: ${oneLine(error.message)}`);
      continue;
    }
    for (const target of f.bulk) addCategory(summary.categories, target.kind, target.bytes);
    summary.builders.push({ id, phase: f.phase, bytes: f.bytes, targets: f.bulk.map((t) => t.kind) });
    summary.reclaimedBytes += f.bytes;
  }
  const worktrees = parseWorktreeList(await runGit(root, ["worktree", "list", "--porcelain"], env));
  for (const [index, wt] of worktrees.entries()) {
    const f = await gatherWorktree(wt, index, { root, cwds, env });
    const decision = worktreeDecision(f, cutoffMs);
    if (decision.action === "keep") {
      skip("worktree", wt.path, decision.reason);
      continue;
    }
    const bytes = treeBytes(wt.path);
    try {
      if (decision.archive && apply) await setRef(root, decision.archive.ref, decision.archive.sha, env);
      if (decision.archive) summary.archives.push({ ref: decision.archive.ref, sha: decision.archive.sha, source: wt.path });
      if (apply && decision.action === "remove") await runGit(root, ["worktree", "remove", wt.path], env);
    } catch (error) {
      skip("worktree", wt.path, `remove failed: ${oneLine(error.stderr || error.message)}`);
      continue;
    }
    if (decision.action === "remove") addCategory(summary.categories, "worktrees", bytes);
    summary.worktrees.push({ path: wt.path, branch: wt.branch, detached: wt.detached, bytes: decision.action === "remove" ? bytes : 0, action: decision.action });
    summary.reclaimedBytes += decision.action === "remove" ? bytes : 0;
  }
  if (apply) await runGit(root, ["worktree", "prune"], env);
  for (const item of summary.skipped) {
    const key = item.reason.split(":")[0];
    summary.skipReasons[key] = (summary.skipReasons[key] ?? 0) + 1;
  }
  return summary;
}

function formatBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  return `${bytes} B`;
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
    const summary = await pruneRepo({ env, root, olderThanMs: flags.olderThanMs, apply: flags.apply });
    out.write(flags.json ? `${JSON.stringify(summary, null, 2)}\n` : renderPrune(summary));
    return 0;
  } catch (error) {
    err.write(`ai-collab: prune: ${error.message}\n`);
    return 1;
  }
}
