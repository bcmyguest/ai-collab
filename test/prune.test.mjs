import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stateDir } from "../lib/config.mjs";
import {
  builderDecision, isProtectedCheckout, parseAge, parsePruneArgs, parseWorktreeList, pruneRepo, readLiveCwds, treeBytes, worktreeDecision,
} from "../lib/prune.mjs";

const NOW = Date.parse("2026-11-25T00:00:00Z");
const WEEK = 7 * 86_400_000;
const CUTOFF = NOW - WEEK;
const OLD_ISO = "2026-01-01T00:00:00Z";
const OLD = Date.parse(OLD_ISO);
const MB = 1_000_000;

function gitEnv(extra = {}) {
  const env = { ...process.env, ...extra, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  return env;
}

function git(cwd, args, extra) {
  return execFileSync("git", ["-C", cwd, ...args], { env: gitEnv(extra), encoding: "utf8" }).trim();
}

function commitOld(cwd, file) {
  writeFileSync(path.join(cwd, file), `${file}\n`);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-q", "-m", `old ${file}`], { GIT_AUTHOR_DATE: OLD_ISO, GIT_COMMITTER_DATE: OLD_ISO });
}

function setOld(target) {
  utimesSync(target, OLD / 1000, OLD / 1000);
}

function fixtureEnv(home) {
  const units = path.join(home, "units");
  mkdirSync(units);
  const systemctl = path.join(home, "fake-systemctl");
  writeFileSync(systemctl, "#!/bin/sh\nf=\"$FAKE_UNITS/$6\"\nif [ -f \"$f\" ]; then cat \"$f\"; else echo inactive; fi\n");
  chmodSync(systemctl, 0o755);
  return { ...gitEnv(), HOME: home, AI_COLLAB_STATE_DIR: path.join(home, "state"), AI_COLLAB_SYSTEMCTL_BIN: systemctl, FAKE_UNITS: units };
}

function makeRepo(home) {
  const repo = path.join(home, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repo, "notes.md"), "# notes\n");
  writeFileSync(path.join(repo, ".gitignore"), "*.log\n");
  git(repo, ["add", "notes.md", ".gitignore"]);
  git(repo, ["commit", "-q", "-m", "init"], { GIT_AUTHOR_DATE: OLD_ISO, GIT_COMMITTER_DATE: OLD_ISO });
  setOld(repo);
  return repo;
}

function makeWorktrees(home, repo) {
  const wt = path.join(home, "wt");
  mkdirSync(wt);
  const at = (name) => path.join(wt, name);
  const paths = {};
  paths.merged = at("merged");
  git(repo, ["worktree", "add", "-q", "-b", "merged", paths.merged, "main"]);
  writeFileSync(path.join(paths.merged, "cache.log"), "ignored\n");
  paths.unmerged = at("unmerged");
  git(repo, ["worktree", "add", "-q", "-b", "unmerged", paths.unmerged, "main"]);
  commitOld(paths.unmerged, "feature.txt");
  paths.dirty = at("dirty");
  git(repo, ["worktree", "add", "-q", "-b", "dirty", paths.dirty, "main"]);
  writeFileSync(path.join(paths.dirty, "notes.md"), "changed\n");
  paths.untracked = at("untracked");
  git(repo, ["worktree", "add", "-q", "-b", "untracked", paths.untracked, "main"]);
  writeFileSync(path.join(paths.untracked, "new.txt"), "new\n");
  paths.locked = at("locked");
  git(repo, ["worktree", "add", "-q", "-b", "locked", paths.locked, "main"]);
  git(repo, ["worktree", "lock", paths.locked]);
  paths.detached = at("detached");
  git(repo, ["worktree", "add", "-q", "--detach", paths.detached, "main"]);
  commitOld(paths.detached, "detached.txt");
  paths.busy = at("busy");
  git(repo, ["worktree", "add", "-q", "-b", "busy", paths.busy, "main"]);
  paths.recent = at("recent");
  git(repo, ["worktree", "add", "-q", "-b", "recent", paths.recent, "main"]);
  writeFileSync(path.join(paths.recent, "now.txt"), "now\n");
  git(paths.recent, ["add", "now.txt"]);
  git(paths.recent, ["commit", "-q", "-m", "now"]);
  for (const name of ["merged", "unmerged", "dirty", "untracked", "locked", "detached", "busy"]) setOld(paths[name]);
  return { paths, detachedSha: git(paths.detached, ["rev-parse", "HEAD"]) };
}

function makeBuilder(env, repo, id, opts = {}) {
  const { phase = "finished", commits = 0, landed = false, back = false, pid = 0, mtime = OLD, unit = "" } = opts;
  const dir = path.join(stateDir(env), "builders", id);
  const worktree = path.join(env.HOME, `ai-collab-wt-${id}`);
  const name = path.basename(worktree);
  mkdirSync(path.join(dir, "stage", name, "node_modules"), { recursive: true });
  mkdirSync(path.join(dir, "stage", "tools", "bin"), { recursive: true });
  writeFileSync(path.join(dir, "stage", name, "big.bin"), Buffer.alloc(MB, 1));
  writeFileSync(path.join(dir, "stage", "tools", "bin", "git"), "bin\n");
  writeFileSync(path.join(dir, "brief.md"), "brief\n");
  writeFileSync(path.join(dir, "policy.yaml"), "version: 1\n");
  writeFileSync(path.join(dir, "workflow-1.db"), "journal\n");
  mkdirSync(path.join(dir, "out", "ai-collab"), { recursive: true });
  writeFileSync(path.join(dir, "out", "ai-collab", "call"), "record\n");
  writeFileSync(path.join(dir, "run.log"), Buffer.alloc(2 * MB, 97));
  writeFileSync(path.join(dir, "small.log"), "short\n");
  mkdirSync(path.join(dir, "download-1"));
  writeFileSync(path.join(dir, "download-1", "big.bin"), Buffer.alloc(MB, 2));
  const state = path.join(dir, "state.json");
  writeFileSync(state, JSON.stringify({ id, phase, root: repo, worktree, unit: unit || `builder-${id}`, commits, landed, pid }));
  const when = new Date(mtime);
  utimesSync(state, when, when);
  let backHead = null;
  if (back) {
    const clone = path.join(dir, "back", name);
    mkdirSync(clone, { recursive: true });
    git(clone, ["init", "-q", "-b", "work"]);
    writeFileSync(path.join(clone, "work.txt"), `${id}\n`);
    git(clone, ["add", "work.txt"]);
    git(clone, ["commit", "-q", "-m", `work ${id}`], { GIT_AUTHOR_DATE: OLD_ISO, GIT_COMMITTER_DATE: OLD_ISO });
    backHead = git(clone, ["rev-parse", "HEAD"]);
  }
  return { dir, backHead };
}

function fixture(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-prune-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = fixtureEnv(home);
  const repo = makeRepo(home);
  const { paths, detachedSha } = makeWorktrees(home, repo);
  const builders = {
    "fin-clean": makeBuilder(env, repo, "fin-clean"),
    "fail-old": makeBuilder(env, repo, "fail-old", { phase: "failed" }),
    "stop-old": makeBuilder(env, repo, "stop-old", { phase: "stopped" }),
    unlanded: makeBuilder(env, repo, "unlanded", { commits: 2, back: true }),
    landed: makeBuilder(env, repo, "landed", { commits: 1, landed: true, back: true }),
    "unlanded-noclone": makeBuilder(env, repo, "unlanded-noclone", { commits: 1 }),
    running: makeBuilder(env, repo, "running", { phase: "running" }),
    staging: makeBuilder(env, repo, "staging", { phase: "staging" }),
    "active-unit": makeBuilder(env, repo, "active-unit", { unit: "builder-active-unit" }),
    alive: makeBuilder(env, repo, "alive", { pid: process.pid }),
    recent: makeBuilder(env, repo, "recent", { mtime: NOW - 1000 }),
  };
  writeFileSync(path.join(env.FAKE_UNITS, "builder-active-unit"), "active\n");
  const broken = path.join(stateDir(env), "builders", "broken");
  mkdirSync(broken, { recursive: true });
  writeFileSync(path.join(broken, "state.json"), "{");
  const busy = spawn("sleep", ["60"], { cwd: paths.busy, stdio: "ignore" });
  t.after(() => busy.kill());
  return { home, env, repo, paths, detachedSha, builders, broken };
}

// One map per run: "builder:<id>" or "worktree:<name>" to "remove" or the keep reason.
function outcomes(summary) {
  const out = {};
  for (const b of summary.builders) out[`builder:${b.id}`] = "remove";
  for (const w of summary.worktrees) if (w.action === "remove") out[`worktree:${path.basename(w.path)}`] = "remove";
  for (const s of summary.skipped) {
    const name = s.kind === "worktree" ? path.basename(s.key) : s.key;
    out[`${s.kind}:${name}`] = s.reason;
  }
  return out;
}

const EXPECTED_OUTCOMES = {
  "builder:fin-clean": "remove",
  "builder:fail-old": "remove",
  "builder:stop-old": "remove",
  "builder:unlanded": "remove",
  "builder:landed": "remove",
  "builder:unlanded-noclone": "unpreserved commits: no clone",
  "builder:running": "unsettled: running",
  "builder:staging": "unsettled: staging",
  "builder:active-unit": "unit active",
  "builder:alive": "process alive",
  "builder:recent": "newer than cutoff",
  "builder:broken": "unreadable: state.json unreadable",
  "worktree:repo": "main worktree",
  "worktree:merged": "remove",
  "worktree:unmerged": "remove",
  "worktree:detached": "remove",
  "worktree:dirty": "dirty: 1 changed or untracked file(s)",
  "worktree:untracked": "dirty: 1 changed or untracked file(s)",
  "worktree:locked": "locked",
  "worktree:busy": "in use: a live process has its cwd inside",
  "worktree:recent": "newer than cutoff",
};

test("parseAge reads s, m, h and d and rejects anything else", () => {
  assert.equal(parseAge("7d"), 7 * 86_400_000);
  assert.equal(parseAge("12h"), 12 * 3_600_000);
  assert.equal(parseAge("30m"), 30 * 60_000);
  assert.equal(parseAge("45s"), 45_000);
  assert.equal(parseAge("7"), null);
  assert.equal(parseAge("x"), null);
  assert.equal(parseAge(undefined), null);
});

test("parsePruneArgs defaults to a 7 day dry run and rejects unknown flags", () => {
  assert.deepEqual(parsePruneArgs([]), { apply: false, json: false, olderThan: "7d", olderThanMs: WEEK });
  assert.deepEqual(parsePruneArgs(["--apply", "--older-than", "12h", "--json"]), { apply: true, json: true, olderThan: "12h", olderThanMs: 12 * 3_600_000 });
  assert.equal(parsePruneArgs(["--bogus"]), null);
  assert.equal(parsePruneArgs(["--older-than", "x"]), null);
  assert.equal(parsePruneArgs(["--older-than"]), null);
});

test("parseWorktreeList reads porcelain records and flags", () => {
  const text = [
    "worktree /r", "HEAD aaa", "branch refs/heads/main", "",
    "worktree /w/a", "HEAD bbb", "detached", "locked reason", "",
    "worktree /w/b", "HEAD ccc", "branch refs/heads/feat/x", "prunable gitdir file points to non-existent location", "",
  ].join("\n");
  assert.deepEqual(parseWorktreeList(text), [
    { path: "/r", head: "aaa", branch: "refs/heads/main", detached: false, locked: false, prunable: false },
    { path: "/w/a", head: "bbb", branch: null, detached: true, locked: true, prunable: false },
    { path: "/w/b", head: "ccc", branch: "refs/heads/feat/x", detached: false, locked: false, prunable: true },
  ]);
});

test("worktreeDecision keeps main, protected, locked, dirty, in-use and recent worktrees", () => {
  const base = { main: false, protected: false, locked: false, prunable: false, detached: false, head: "h", path: "/w",
    dirty: 0, error: "", lastActivityMs: OLD, inUse: false, archiveRef: "refs/ai-collab/archive/wt-w", archiveSha: null };
  assert.equal(worktreeDecision({ ...base, main: true }, CUTOFF).reason, "main worktree");
  assert.equal(worktreeDecision({ ...base, protected: true }, CUTOFF).reason, "protected checkout");
  assert.equal(worktreeDecision({ ...base, locked: true }, CUTOFF).reason, "locked");
  assert.equal(worktreeDecision({ ...base, dirty: 2 }, CUTOFF).reason, "dirty: 2 changed or untracked file(s)");
  assert.equal(worktreeDecision({ ...base, inUse: true }, CUTOFF).reason, "in use: a live process has its cwd inside");
  assert.equal(worktreeDecision({ ...base, lastActivityMs: NOW }, CUTOFF).reason, "newer than cutoff");
  assert.equal(worktreeDecision({ ...base, error: "boom" }, CUTOFF).action, "keep");
});

test("isProtectedCheckout matches the checkout itself, not worktrees under it", () => {
  assert.equal(isProtectedCheckout("/home/b/ai-collab", "/home/b/ai-collab"), true);
  assert.equal(isProtectedCheckout("/home/b/ai-collab-serving", "/tmp/elsewhere"), true);
  assert.equal(isProtectedCheckout("/home/b/ai-collab/.claude/worktrees/agent-x", "/home/b/ai-collab"), false);
  assert.equal(isProtectedCheckout("/home/b/ai-collab-wt-x", "/home/b/ai-collab"), false);
});

test("worktreeDecision removes clean branch worktrees and archives detached HEADs first", () => {
  const base = { main: false, protected: false, locked: false, prunable: false, detached: false, head: "h", path: "/w",
    dirty: 0, error: "", lastActivityMs: OLD, inUse: false, archiveRef: "refs/ai-collab/archive/wt-w", archiveSha: null };
  assert.deepEqual(worktreeDecision(base, CUTOFF), { action: "remove", reason: "clean", archive: null });
  assert.deepEqual(worktreeDecision({ ...base, detached: true }, CUTOFF),
    { action: "remove", reason: "detached", archive: { ref: "refs/ai-collab/archive/wt-w", sha: "h" } });
  assert.equal(worktreeDecision({ ...base, detached: true, archiveSha: "h" }, CUTOFF).archive, null);
  assert.equal(worktreeDecision({ ...base, detached: true, archiveSha: "other" }, CUTOFF).action, "keep");
  assert.equal(worktreeDecision({ ...base, prunable: true }, CUTOFF).action, "prune");
});

test("builderDecision removes settled builders past the cutoff and keeps everything else", () => {
  const base = { id: "x", error: "", phase: "finished", commits: 0, landed: false, root: "/r", mtimeMs: OLD, unitActive: "inactive",
    pidAlive: false, bytes: 100, backSha: null, archiveRef: "refs/ai-collab/archive/x", archiveSha: null };
  assert.deepEqual(builderDecision(base, CUTOFF), { action: "remove", reason: "finished", archive: null });
  assert.equal(builderDecision({ ...base, phase: "running" }, CUTOFF).reason, "unsettled: running");
  assert.equal(builderDecision({ ...base, unitActive: "active" }, CUTOFF).reason, "unit active");
  assert.equal(builderDecision({ ...base, unitActive: "unknown" }, CUTOFF).action, "keep");
  assert.equal(builderDecision({ ...base, pidAlive: true }, CUTOFF).reason, "process alive");
  assert.equal(builderDecision({ ...base, mtimeMs: NOW }, CUTOFF).reason, "newer than cutoff");
  assert.equal(builderDecision({ ...base, bytes: 0 }, CUTOFF).reason, "nothing to reclaim");
  assert.equal(builderDecision({ ...base, error: "bad" }, CUTOFF).action, "keep");
});

test("builderDecision archives unlanded commits from the clone before removal", () => {
  const base = { id: "x", error: "", phase: "finished", commits: 2, landed: false, root: "/r", mtimeMs: OLD, unitActive: "inactive",
    pidAlive: false, bytes: 100, backSha: "b1", archiveRef: "refs/ai-collab/archive/x", archiveSha: null };
  assert.deepEqual(builderDecision(base, CUTOFF), { action: "remove", reason: "finished", archive: { ref: "refs/ai-collab/archive/x", sha: "b1" } });
  assert.equal(builderDecision({ ...base, archiveSha: "b1" }, CUTOFF).archive, null);
  assert.equal(builderDecision({ ...base, archiveSha: "b0" }, CUTOFF).reason, "archive ref differs from clone");
  assert.equal(builderDecision({ ...base, backSha: null }, CUTOFF).reason, "unpreserved commits: no clone");
  assert.equal(builderDecision({ ...base, root: null }, CUTOFF).reason, "unpreserved commits: no project root");
  assert.equal(builderDecision({ ...base, landed: true }, CUTOFF).archive, null);
});

test("treeBytes counts disk blocks and each inode once", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai-collab-prune-bytes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "a.bin"), Buffer.alloc(MB, 1));
  const one = treeBytes(dir);
  assert.ok(one >= MB);
  execFileSync("ln", [path.join(dir, "a.bin"), path.join(dir, "b.bin")]);
  assert.equal(treeBytes(dir), one);
  assert.equal(treeBytes(path.join(dir, "missing")), 0);
});

test("readLiveCwds reports the cwd of a running child process", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai-collab-prune-cwd-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = spawn("sleep", ["60"], { cwd: dir, stdio: "ignore" });
  t.after(() => child.kill());
  assert.ok(readLiveCwds().includes(realpathSync(dir)));
});

test("a node_modules symlink alone is removable and its target survives", async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-prune-nm-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = fixtureEnv(home);
  const repo = makeRepo(home);
  const wt = path.join(home, "wt");
  mkdirSync(wt);
  const target = path.join(home, "shared-node-modules");
  mkdirSync(path.join(target, "pkg"), { recursive: true });
  writeFileSync(path.join(target, "pkg", "index.js"), "export {};\n");
  const linkOnly = path.join(wt, "linkonly");
  git(repo, ["worktree", "add", "-q", "-b", "linkonly", linkOnly, "main"]);
  symlinkSync(target, path.join(linkOnly, "node_modules"));
  const realDir = path.join(wt, "realdir");
  git(repo, ["worktree", "add", "-q", "-b", "realdir", realDir, "main"]);
  mkdirSync(path.join(realDir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(path.join(realDir, "node_modules", "pkg", "index.js"), "x\n");
  const linkPlus = path.join(wt, "linkplus");
  git(repo, ["worktree", "add", "-q", "-b", "linkplus", linkPlus, "main"]);
  symlinkSync(target, path.join(linkPlus, "node_modules"));
  writeFileSync(path.join(linkPlus, "scratch.txt"), "scratch\n");
  for (const p of [linkOnly, realDir, linkPlus]) setOld(p);
  const before = readdirSync(target, { recursive: true }).sort();
  const dry = await pruneRepo({ env, root: repo, olderThanMs: WEEK, apply: false, now: NOW });
  const decided = outcomes(dry);
  assert.equal(decided["worktree:linkonly"], "remove");
  assert.equal(decided["worktree:realdir"], "dirty: 2 changed or untracked file(s)");
  assert.equal(decided["worktree:linkplus"], "dirty: 1 changed or untracked file(s)");
  assert.ok(existsSync(linkOnly));
  const applied = await pruneRepo({ env, root: repo, olderThanMs: WEEK, apply: true, now: NOW });
  assert.equal(outcomes(applied)["worktree:linkonly"], "remove");
  assert.ok(!existsSync(linkOnly));
  assert.ok(existsSync(realDir) && existsSync(linkPlus));
  assert.deepEqual(readdirSync(target, { recursive: true }).sort(), before);
  assert.equal(readFileSync(path.join(target, "pkg", "index.js"), "utf8"), "export {};\n");
});

test("prune dry run decides every candidate and deletes nothing", async (t) => {
  const f = fixture(t);
  const refsBefore = git(f.repo, ["for-each-ref", "refs/ai-collab"]);
  const summary = await pruneRepo({ env: f.env, root: f.repo, olderThanMs: WEEK, apply: false, now: NOW });
  assert.equal(summary.mode, "dry-run");
  assert.deepEqual(outcomes(summary), EXPECTED_OUTCOMES);
  for (const id of Object.keys(f.builders)) assert.ok(existsSync(f.builders[id].dir));
  assert.ok(existsSync(path.join(stateDir(f.env), "builders", "fin-clean", "stage")));
  assert.ok(existsSync(f.paths.merged));
  assert.ok(existsSync(f.paths.detached));
  assert.equal(git(f.repo, ["for-each-ref", "refs/ai-collab"]), refsBefore);
  assert.ok(summary.reclaimedBytes >= 2 * MB * summary.builders.length);
});

test("prune apply removes only the decided copies and keeps every commit reachable", async (t) => {
  const f = fixture(t);
  const dry = await pruneRepo({ env: f.env, root: f.repo, olderThanMs: WEEK, apply: false, now: NOW });
  const reachableBefore = git(f.repo, ["rev-list", "--all", f.detachedSha]).split("\n");
  const unlandedHead = f.builders.unlanded.backHead;
  const summary = await pruneRepo({ env: f.env, root: f.repo, olderThanMs: WEEK, apply: true, now: NOW });
  assert.equal(summary.mode, "apply");
  assert.equal(summary.reclaimedBytes, dry.reclaimedBytes);
  assert.ok(summary.reclaimedBytes >= 2 * MB * summary.builders.length);
  assert.deepEqual(summary.builders.map((b) => b.id).sort(), ["fail-old", "fin-clean", "landed", "stop-old", "unlanded"]);

  assert.equal(git(f.repo, ["rev-parse", "refs/ai-collab/archive/unlanded"]), unlandedHead);
  assert.equal(git(f.repo, ["rev-parse", "refs/ai-collab/archive/wt-detached"]), f.detachedSha);
  assert.ok(git(f.repo, ["rev-list", "--all"]).split("\n").includes(unlandedHead));
  assert.ok(git(f.repo, ["rev-list", "--all"]).split("\n").includes(f.detachedSha));
  const reachableAfter = new Set(git(f.repo, ["rev-list", "--all"]).split("\n"));
  for (const sha of reachableBefore) assert.ok(reachableAfter.has(sha), `lost ${sha}`);

  const stateOf = (id) => path.join(stateDir(f.env), "builders", id);
  assert.ok(!existsSync(path.join(stateOf("fin-clean"), "stage")));
  assert.ok(!existsSync(path.join(stateOf("fin-clean"), "download-1")));
  assert.ok(!existsSync(path.join(stateOf("fin-clean"), "run.log")));
  assert.ok(existsSync(path.join(stateOf("fin-clean"), "small.log")));
  assert.ok(existsSync(path.join(stateOf("fin-clean"), "state.json")));
  assert.ok(existsSync(path.join(stateOf("fin-clean"), "workflow-1.db")));
  assert.ok(existsSync(path.join(stateOf("fin-clean"), "out", "ai-collab", "call")));
  assert.ok(!existsSync(path.join(stateOf("unlanded"), "back")));
  assert.ok(existsSync(path.join(stateOf("unlanded"), "state.json")));
  assert.ok(existsSync(path.join(stateOf("unlanded-noclone"), "stage")));
  assert.ok(existsSync(path.join(stateOf("running"), "stage")));
  assert.ok(existsSync(path.join(stateOf("broken"), "state.json")));

  assert.ok(!existsSync(f.paths.merged));
  assert.ok(!existsSync(f.paths.unmerged));
  assert.ok(!existsSync(f.paths.detached));
  assert.ok(existsSync(f.paths.dirty));
  assert.ok(existsSync(f.paths.untracked));
  assert.ok(existsSync(f.paths.locked));
  assert.ok(existsSync(f.paths.busy));
  assert.ok(existsSync(f.paths.recent));
  const branches = git(f.repo, ["branch", "--list"]);
  assert.ok(branches.includes("merged") && branches.includes("unmerged") && branches.includes("busy"));
});
