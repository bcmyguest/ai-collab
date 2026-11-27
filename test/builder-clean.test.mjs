import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { builderLiveRefusal, buildersToRemove, cleanBuilders, worktreeIsProtected } from "../lib/builder-clean.ts";
import { stateDir } from "../lib/config.mjs";
import { tempDir } from "./helpers/tmp.mjs";

test("buildersToRemove keeps running and staging and drops oldest finished, then failed, then stopped", () => {
  const rows = [
    { id: "stopped-oldest", phase: "stopped", mtime: 1 },
    { id: "failed-old", phase: "failed", mtime: 2 },
    { id: "failed-new", phase: "failed", mtime: 4 },
    { id: "finished-old", phase: "finished", mtime: 3 },
    { id: "finished-new", phase: "finished", mtime: 100 },
    { id: "running-oldest", phase: "running", mtime: 0 },
    { id: "staging-old", phase: "staging", mtime: 0 },
    { id: "starting", phase: "starting", mtime: 0 },
  ];
  assert.deepEqual(buildersToRemove(rows, 5), ["finished-old", "finished-new", "failed-old"]);
  assert.deepEqual(buildersToRemove(rows, 6), ["finished-old", "finished-new"]);
  assert.deepEqual(buildersToRemove(rows, 7), ["finished-old"]);
  assert.deepEqual(
    buildersToRemove(rows, 4),
    ["finished-old", "finished-new", "failed-old", "failed-new"],
  );
  assert.deepEqual(buildersToRemove(rows, 50), []);
  assert.deepEqual(buildersToRemove([
    { id: "running-only", phase: "running", mtime: 1 },
    { id: "staging-only", phase: "staging", mtime: 1 },
  ], 1), []);
});

test("worktreeIsProtected refuses the main checkout and the serving checkout", () => {
  assert.equal(worktreeIsProtected("/home/b/ai-collab", "/home/b/ai-collab"), true);
  assert.equal(worktreeIsProtected("/home/b/ai-collab/lib", "/tmp/elsewhere"), true);
  assert.equal(worktreeIsProtected("/home/b/ai-collab-serving", "/tmp/elsewhere"), true);
  assert.equal(worktreeIsProtected("/home/b/ai-collab-serving/web", "/tmp/elsewhere"), true);
  assert.equal(worktreeIsProtected("/home/b/ai-collab-wt-finished-one", "/home/b/ai-collab"), false);
});

test("cleanBuilders removes the selected state dir and its worktree without touching a protected checkout", async (t) => {
  const home = tempDir(t, "ai-collab-builder-clean-");
  const repo = path.join(home, "repo");
  const env = {
    ...process.env,
    HOME: home,
    AI_COLLAB_STATE_DIR: path.join(home, "state"),
    AI_COLLAB_BUILDER_WORKTREES: home,
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  assert.ok(stateDir(env).startsWith(home));
  mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  writeFileSync(path.join(repo, "notes.md"), "# notes\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");

  const stamp = (id, phase, mtime, withWorktree) => {
    const dir = path.join(stateDir(env), "builders", id);
    const worktree = path.join(home, `ai-collab-wt-${id}`);
    mkdirSync(dir, { recursive: true });
    if (withWorktree) git("worktree", "add", "-q", "-b", `builder/${id}`, worktree, "main");
    writeFileSync(path.join(dir, "state.json"), `${JSON.stringify({ id, phase, root: repo, worktree })}\n`);
    const when = new Date(mtime);
    utimesSync(path.join(dir, "state.json"), when, when);
  };
  stamp("old-fin", "finished", 1_000, true);
  stamp("new-fin", "finished", 5_000, true);
  stamp("live-run", "running", 100, true);
  symlinkSync(repo, path.join(home, "ai-collab-wt-linked"));
  const linked = path.join(stateDir(env), "builders", "linked");
  mkdirSync(linked, { recursive: true });
  writeFileSync(path.join(linked, "state.json"), `${JSON.stringify({
    id: "linked", phase: "finished", root: repo, worktree: path.join(home, "ai-collab-wt-linked"),
  })}\n`);
  utimesSync(path.join(linked, "state.json"), new Date(2_000), new Date(2_000));

  const removed = await cleanBuilders(env, { cap: 2 });
  assert.deepEqual(removed, ["old-fin", "linked"]);
  assert.equal(existsSync(path.join(stateDir(env), "builders", "old-fin")), false);
  assert.equal(existsSync(path.join(home, "ai-collab-wt-old-fin")), false);
  assert.equal(existsSync(path.join(stateDir(env), "builders", "new-fin")), true);
  assert.equal(existsSync(path.join(home, "ai-collab-wt-new-fin")), true);
  assert.equal(existsSync(path.join(stateDir(env), "builders", "live-run")), true);
  assert.equal(existsSync(path.join(home, "ai-collab-wt-live-run")), true);
  assert.equal(existsSync(path.join(home, "ai-collab-wt-linked")), true);
  assert.equal(readFileSync(path.join(repo, "notes.md"), "utf8"), "# notes\n");
  assert.match(git("worktree", "list"), /ai-collab-wt-new-fin/);
  assert.doesNotMatch(git("worktree", "list"), /ai-collab-wt-old-fin/);
  rmSync(home, { recursive: true, force: true });
});

test("builderLiveRefusal allows one live builder and refuses a third", (t) => {
  const home = tempDir(t, "ai-collab-builder-live-");
  const env = { ...process.env, HOME: home, AI_COLLAB_STATE_DIR: path.join(home, "state") };
  const stamp = (id, phase) => {
    const dir = path.join(stateDir(env), "builders", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "state.json"), `${JSON.stringify({ id, phase })}\n`);
  };
  stamp("one", "running");
  assert.equal(builderLiveRefusal(env), "");
  stamp("two", "staging");
  assert.match(builderLiveRefusal(env), /2 builders are already running or staging/);
  rmSync(home, { recursive: true, force: true });
});
