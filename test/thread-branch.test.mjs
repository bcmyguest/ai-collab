import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gitRunner } from "../lib/sessions/git-refs.ts";
import { findExecutable } from "../lib/sessions/scope.ts";
import { spawnAgent } from "../lib/spawn.ts";
import { mergeIntoParent, parentBranch } from "../lib/thread-branch.ts";
import { fileEnd, tempDir } from "./helpers/tmp.mjs";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null" };
const run = gitRunner(findExecutable("git", process.env.PATH), ENV);
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
const commit = (cwd, file, text) => { writeFileSync(path.join(cwd, file), text); git(cwd, "add", file); git(cwd, "commit", "-qm", file); };

// A repo on main, a parent worktree on thread/x, and a child worktree on a branch cut from thread/x.
function repo(t) {
  const dir = tempDir(fileEnd, "ai-collab-thread-branch-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "root");
  execFileSync("git", ["init", "-q", "-b", "main", root], { env: ENV });
  commit(root, "a.txt", "a\n");
  const parent = path.join(dir, "parent");
  git(root, "worktree", "add", "-q", "-b", "thread/x", parent);
  commit(parent, "p.txt", "p\n");
  const child = path.join(dir, "child");
  git(root, "worktree", "add", "-q", "-b", "child/1", child, "thread/x");
  return { root, parent, child };
}

test("a child's commits rebase onto the parent's branch and fast-forward its checkout", async (t) => {
  const { parent, child } = repo(t);
  commit(child, "c.txt", "c\n");
  commit(parent, "p2.txt", "p2\n"); // the parent moved on, so the child needs a rebase
  assert.equal(await mergeIntoParent(run, child, "thread/x"), "merged 1 commit from child/1 into thread/x");
  assert.equal(git(parent, "rev-parse", "HEAD"), git(child, "rev-parse", "HEAD"));
  assert.equal(git(parent, "log", "--format=%s", "-3"), "c.txt\np2.txt\np.txt");
  assert.equal(git(parent, "status", "--porcelain"), "");
});

test("a conflict leaves both branches as they were and names the files", async (t) => {
  const { parent, child } = repo(t);
  commit(child, "p.txt", "child\n");
  commit(parent, "p.txt", "parent\n");
  const before = [git(parent, "rev-parse", "HEAD"), git(child, "rev-parse", "HEAD")];
  assert.equal(await mergeIntoParent(run, child, "thread/x"), "not merged into thread/x: child/1 conflicts with it in p.txt; both branches are unchanged");
  assert.deepEqual([git(parent, "rev-parse", "HEAD"), git(child, "rev-parse", "HEAD")], before);
  assert.equal(git(child, "status", "--porcelain"), "");
});

test("nothing new, uncommitted edits and main are not merged", async (t) => {
  const { root, child } = repo(t);
  assert.equal(await mergeIntoParent(run, child, "thread/x"), "");
  commit(child, "c.txt", "c\n");
  writeFileSync(path.join(child, "c.txt"), "edited\n");
  assert.match(await mergeIntoParent(run, child, "thread/x"), /has uncommitted changes/);
  assert.match(await mergeIntoParent(run, child, "main"), /landed by the operator/);
  assert.equal(git(root, "log", "--format=%s", "main"), "a.txt");
});

test("a branch no worktree has checked out moves by branch -f", async (t) => {
  const { root, parent, child } = repo(t);
  git(parent, "checkout", "-q", "--detach");
  commit(child, "c.txt", "c\n");
  assert.equal(await mergeIntoParent(run, child, "thread/x"), "merged 1 commit from child/1 into thread/x");
  assert.equal(git(root, "rev-parse", "thread/x"), git(child, "rev-parse", "HEAD"));
});

test("parentBranch names a thread branch and skips main and a detached HEAD", async (t) => {
  const { root, parent } = repo(t);
  assert.equal(await parentBranch(run, parent), "thread/x");
  assert.equal(await parentBranch(run, root), null);
  git(parent, "checkout", "-q", "--detach");
  assert.equal(await parentBranch(run, parent), null);
});

test("spawn_agent with a worktree asks for the parent's branch as base and merge target", async (t) => {
  const { root, parent } = repo(t);
  const bodies = [];
  const request = async (_method, _path, body) => { bodies.push(body); return { status: 201, body: { status: "started", session: "codex#0123456789abcdef", cwd: "/w" } }; };
  const cfg = { project: "demo", peer: "claude", session: "fedcba9876543210" };
  await spawnAgent(cfg, { harness: "codex", brief: "do it", worktree: true }, { env: ENV, request, cwd: parent });
  await spawnAgent(cfg, { harness: "codex", brief: "do it", worktree: true }, { env: ENV, request, cwd: root });
  await spawnAgent(cfg, { harness: "codex", brief: "do it" }, { env: ENV, request, cwd: parent });
  assert.deepEqual(bodies.map((b) => [b.place, b.base, b.mergeInto]), [["worktree", "thread/x", "thread/x"], ["worktree", undefined, undefined], ["folder", undefined, undefined]]);
});

test("a merge first aborts a rebase an earlier, cut merge left behind", async (t) => {
  const { parent, child } = repo(t);
  commit(child, "p.txt", "child\n");
  commit(parent, "p.txt", "parent\n");
  assert.throws(() => git(child, "rebase", "thread/x"));
  git(child, "checkout", "-q", "--theirs", "p.txt");
  git(parent, "reset", "-q", "--hard", "HEAD~1"); // the parent drops its conflicting commit, so a clean merge is possible
  assert.equal(await mergeIntoParent(run, child, "thread/x"), "merged 1 commit from child/1 into thread/x");
  assert.equal(git(parent, "show", "HEAD:p.txt"), "child");
});
