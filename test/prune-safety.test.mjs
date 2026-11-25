import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stateDir } from "../lib/config.mjs";
import { parsePruneArgs, pruneRepo } from "../lib/prune.mjs";

const NOW = Date.parse("2026-11-25T00:00:00Z");
const WEEK = 7 * 86_400_000;
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

function setOld(target) {
  utimesSync(target, OLD / 1000, OLD / 1000);
}

function ageTree(target) {
  for (const name of readdirSync(target)) {
    if (name === ".git") continue;
    const full = path.join(target, name);
    const info = lstatSync(full);
    if (info.isSymbolicLink()) lutimesSync(full, OLD / 1000, OLD / 1000);
    else if (info.isDirectory()) { ageTree(full); setOld(full); }
    else setOld(full);
  }
}

function ageAdmin(repo, name) {
  const admin = path.join(repo, ".git", "worktrees", name);
  const log = path.join(admin, "logs", "HEAD");
  if (existsSync(log)) writeFileSync(log, readFileSync(log, "utf8").replace(/\d{10} [+-]\d{4}/g, `${OLD / 1000} +0000`));
  for (const file of ["index", "HEAD", "gitdir", "logs/HEAD"]) {
    if (existsSync(path.join(admin, file))) setOld(path.join(admin, file));
  }
}

function ageWorktree(repo, target) {
  ageTree(target);
  ageAdmin(repo, path.basename(target));
  setOld(target);
}

function fixtureEnv(home) {
  const units = path.join(home, "units");
  mkdirSync(units);
  const systemctl = path.join(home, "fake-systemctl");
  writeFileSync(systemctl, "#!/bin/sh\necho inactive\n");
  chmodSync(systemctl, 0o755);
  return { ...gitEnv(), HOME: home, AI_COLLAB_STATE_DIR: path.join(home, "state"), AI_COLLAB_SYSTEMCTL_BIN: systemctl, FAKE_UNITS: units };
}

// A repo whose common info/exclude ignores the paths the safety tests write into worktrees.
function scene(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-prune-safe-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = fixtureEnv(home);
  const repo = path.join(home, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repo, "notes.md"), "# notes\n");
  git(repo, ["add", "notes.md"]);
  git(repo, ["commit", "-q", "-m", "init"], { GIT_AUTHOR_DATE: OLD_ISO, GIT_COMMITTER_DATE: OLD_ISO });
  mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
  appendFileSync(path.join(repo, ".git", "info", "exclude"), ".env\ndist/\n.claude/worktrees/\n");
  return { home, env, repo, wt: path.join(home, "wt") };
}

function addWorktree(s, name, args) {
  mkdirSync(s.wt, { recursive: true });
  const p = path.join(s.wt, name);
  git(s.repo, ["worktree", "add", "-q", ...args(p)]);
  return p;
}

// Keeps reasons per worktree name, plus removals.
function outcomes(summary) {
  const out = {};
  for (const b of summary.builders) out[`builder:${b.id}`] = "remove";
  for (const w of summary.worktrees) if (w.action === "remove") out[`worktree:${path.basename(w.path)}`] = "remove";
  for (const s of summary.skipped) out[`${s.kind}:${s.kind === "worktree" ? path.basename(s.key) : s.key}`] = s.reason;
  return out;
}

test("parsePruneArgs refuses a cutoff under 24h", () => {
  assert.equal(parsePruneArgs(["--older-than", "1h"]), null);
  assert.equal(parsePruneArgs(["--older-than", "23h"]), null);
  assert.equal(parsePruneArgs(["--older-than", "24h"]).olderThanMs, 86_400_000);
});

test("a dry run leaves the worktree admin index untouched", (t) => {
  const s = scene(t);
  const p = addWorktree(s, "clean", (q) => [q, "-b", "clean", "main"]);
  ageWorktree(s.repo, p);
  const index = path.join(s.repo, ".git", "worktrees", "clean", "index");
  const before = lstatSync(index).mtimeMs;
  return pruneRepo({ env: s.env, root: s.repo, olderThanMs: WEEK, apply: false, now: NOW }).then(() => {
    assert.equal(lstatSync(index).mtimeMs, before);
  });
});

test("a failed builder with a dirty clone is archived, not lost", async (t) => {
  const s = scene(t);
  const dir = path.join(stateDir(s.env), "builders", "b1");
  const clone = path.join(dir, "back", "ai-collab-wt-b1");
  mkdirSync(clone, { recursive: true });
  git(clone, ["init", "-q", "-b", "work"]);
  writeFileSync(path.join(clone, "a.txt"), "a\n");
  git(clone, ["add", "a.txt"]);
  git(clone, ["commit", "-q", "-m", "a"], { GIT_AUTHOR_DATE: OLD_ISO, GIT_COMMITTER_DATE: OLD_ISO });
  writeFileSync(path.join(clone, "builder-work.txt"), "work\n");
  git(clone, ["add", "builder-work.txt"]);
  git(clone, ["commit", "-q", "-m", "work"], { GIT_AUTHOR_DATE: OLD_ISO, GIT_COMMITTER_DATE: OLD_ISO });
  const workSha = git(clone, ["rev-parse", "HEAD"]);
  writeFileSync(path.join(clone, "uncommitted.txt"), "x\n");
  writeFileSync(path.join(dir, "state.json"), JSON.stringify({ id: "b1", phase: "failed", commits: 0, root: s.repo, worktree: path.join(s.home, "ai-collab-wt-b1") }));
  setOld(path.join(dir, "state.json"));
  const summary = await pruneRepo({ env: s.env, root: s.repo, olderThanMs: WEEK, apply: true, now: NOW });
  assert.deepEqual(summary.builders.map((b) => b.id), ["b1"]);
  const archived = git(s.repo, ["rev-parse", "refs/ai-collab/archive/b1/HEAD"]);
  assert.equal(git(s.repo, ["cat-file", "-p", `${archived}:uncommitted.txt`]), "x");
  assert.equal(git(s.repo, ["rev-list", "--count", `${workSha}..${archived}`]), "1");
  assert.ok(!existsSync(clone));
});

test("a builder whose task is still open keeps its clone", async (t) => {
  const s = scene(t);
  const dir = path.join(stateDir(s.env), "builders", "open1");
  mkdirSync(path.join(dir, "stage"), { recursive: true });
  writeFileSync(path.join(dir, "stage", "big.bin"), Buffer.alloc(MB, 1));
  writeFileSync(path.join(dir, "state.json"), JSON.stringify({ id: "open1", phase: "finished", task: "t1", root: s.repo, worktree: path.join(s.home, "ai-collab-wt-open1") }));
  setOld(path.join(dir, "state.json"));
  const summary = await pruneRepo({ env: s.env, root: s.repo, olderThanMs: WEEK, apply: false, now: NOW, taskOpen: () => true });
  assert.equal(outcomes(summary)["builder:open1"], "task open");
});

test("a worktree that contains another worktree is kept with its inner worktree", async (t) => {
  const s = scene(t);
  const outer = addWorktree(s, "outer", (p) => [p, "-b", "outer", "main"]);
  const inner = path.join(outer, ".claude", "worktrees", "inner");
  mkdirSync(path.dirname(inner), { recursive: true });
  git(s.repo, ["worktree", "add", "-q", inner, "-b", "inner", "main"]);
  writeFileSync(path.join(inner, "uncommitted.txt"), "precious\n");
  ageWorktree(s.repo, inner);
  ageWorktree(s.repo, outer);
  const summary = await pruneRepo({ env: s.env, root: s.repo, olderThanMs: WEEK, apply: true, now: NOW });
  assert.match(outcomes(summary)["worktree:outer"], /^contains another worktree/);
  assert.ok(existsSync(path.join(inner, "uncommitted.txt")));
});

test("an ignored file outside the allowlist keeps its worktree", async (t) => {
  const s = scene(t);
  const p = addWorktree(s, "ignored", (q) => [q, "-b", "ign", "main"]);
  writeFileSync(path.join(p, ".env"), "SECRET=1\n");
  ageWorktree(s.repo, p);
  const summary = await pruneRepo({ env: s.env, root: s.repo, olderThanMs: WEEK, apply: false, now: NOW });
  assert.match(outcomes(summary)["worktree:ignored"], /^ignored outside allowlist/);
});

test("a fresh file under an allowlisted ignored dir keeps its worktree", async (t) => {
  const s = scene(t);
  const p = addWorktree(s, "fresh", (q) => [q, "-b", "fresh", "main"]);
  mkdirSync(path.join(p, "dist", "deep"), { recursive: true });
  ageWorktree(s.repo, p);
  writeFileSync(path.join(p, "dist", "deep", "fresh.txt"), "edited now\n");
  const summary = await pruneRepo({ env: s.env, root: s.repo, olderThanMs: WEEK, apply: false, now: NOW });
  assert.equal(outcomes(summary)["worktree:fresh"], "newer than cutoff");
});

test("a commit held only by the worktree HEAD reflog keeps its worktree", async (t) => {
  const s = scene(t);
  git(s.repo, ["branch", "rl", "main"]);
  const p = addWorktree(s, "rl", (q) => ["--detach", q, "main"]);
  writeFileSync(path.join(p, "lost.txt"), "lost\n");
  git(p, ["add", "lost.txt"]);
  git(p, ["commit", "-q", "-m", "lost"], { GIT_AUTHOR_DATE: OLD_ISO, GIT_COMMITTER_DATE: OLD_ISO });
  git(p, ["checkout", "-q", "rl"]);
  ageWorktree(s.repo, p);
  const summary = await pruneRepo({ env: s.env, root: s.repo, olderThanMs: WEEK, apply: false, now: NOW });
  assert.equal(outcomes(summary)["worktree:rl"], "HEAD reflog holds commits on no ref");
});

test("a prunable detached worktree has its HEAD archived before pruning", async (t) => {
  const s = scene(t);
  const p = addWorktree(s, "gone", (q) => ["--detach", q, "main"]);
  writeFileSync(path.join(p, "gone.txt"), "gone\n");
  git(p, ["add", "gone.txt"]);
  git(p, ["commit", "-q", "-m", "gone"], { GIT_AUTHOR_DATE: OLD_ISO, GIT_COMMITTER_DATE: OLD_ISO });
  const sha = git(p, ["rev-parse", "HEAD"]);
  ageWorktree(s.repo, p);
  renameSync(p, `${p}.moved`);
  await pruneRepo({ env: s.env, root: s.repo, olderThanMs: WEEK, apply: true, now: NOW });
  assert.equal(git(s.repo, ["rev-parse", "refs/ai-collab/archive/wt-gone"]), sha);
});

test("a worktree whose cwd appears between scan and removal is kept", async (t) => {
  const s = scene(t);
  const p = addWorktree(s, "race", (q) => [q, "-b", "race", "main"]);
  ageWorktree(s.repo, p);
  let calls = 0;
  const cwds = () => (calls++ === 0 ? [] : [p]);
  const summary = await pruneRepo({ env: s.env, root: s.repo, olderThanMs: WEEK, apply: true, now: NOW, cwds });
  assert.equal(outcomes(summary)["worktree:race"], "in use: a live process has its cwd inside");
  assert.ok(existsSync(p));
});

test("a failed removal restores the node_modules symlink it unlinked", async (t) => {
  const s = scene(t);
  const p = addWorktree(s, "stuck", (q) => [q, "-b", "stuck", "main"]);
  const target = path.join(s.home, "shared-nm");
  mkdirSync(target);
  symlinkSync(target, path.join(p, "node_modules"));
  mkdirSync(path.join(p, "dist"));
  writeFileSync(path.join(p, "dist", "blob.bin"), "blob\n");
  ageWorktree(s.repo, p);
  chmodSync(path.join(p, "dist"), 0o555);
  try {
    const summary = await pruneRepo({ env: s.env, root: s.repo, olderThanMs: WEEK, apply: true, now: NOW });
    assert.match(outcomes(summary)["worktree:stuck"], /^remove failed/);
    assert.equal(readlinkSync(path.join(p, "node_modules")), target);
  } finally {
    chmodSync(path.join(p, "dist"), 0o755);
  }
});

test("a session seen inside a worktree within the cutoff keeps it", async (t) => {
  const s = scene(t);
  const p = addWorktree(s, "sess", (q) => [q, "-b", "sess", "main"]);
  ageWorktree(s.repo, p);
  const sessions = () => [{ cwd: p, seenAt: Date.now() }];
  const summary = await pruneRepo({ env: s.env, root: s.repo, olderThanMs: WEEK, apply: false, now: NOW, sessions });
  assert.equal(outcomes(summary)["worktree:sess"], "newer than cutoff");
});
