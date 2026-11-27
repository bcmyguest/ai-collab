import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/tmp.mjs";

const INSTALL = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "install-git-hooks.sh");

function sandbox(t) {
  const root = tempDir({ after }, "main-guard-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  };
  const run = (cwd, ...args) => spawnSync("git", args, { cwd, env, encoding: "utf8" });
  const git = (cwd, ...args) => {
    const result = run(cwd, ...args);
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  // A global pull.rebase=true, as on the host, must not turn a plain pull into a rebase of main.
  git(root, "config", "--global", "pull.rebase", "true");
  git(root, "init", "-q", "--bare", "-b", "main", "remote.git");
  git(root, "clone", "-q", "remote.git", "shared");
  const shared = join(root, "shared");
  const install = spawnSync(INSTALL, [], { env: { ...env, GIT_DIR: join(shared, ".git") }, encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr);
  const commit = (cwd, message) => git(cwd, "commit", "-q", "--allow-empty", "-m", message);
  commit(shared, "one");
  commit(shared, "two");
  git(shared, "push", "-q", "origin", "main");
  return { root, shared, run, git, commit };
}

test("the hook refuses every backward move or delete of main and leaves it unchanged", (t) => {
  const { shared, run, git } = sandbox(t);
  const head = git(shared, "rev-parse", "main");
  const older = git(shared, "rev-parse", "main~1");
  for (const args of [
    ["update-ref", "refs/heads/main", older],
    ["update-ref", "refs/heads/main", "origin/main~1"],
    ["update-ref", "-d", "refs/heads/main"],
    ["reset", "-q", "--hard", "HEAD~1"],
    ["commit", "-q", "--amend", "--allow-empty", "-m", "rewritten"],
  ]) {
    const result = run(shared, ...args);
    assert.notEqual(result.status, 0, `git ${args.join(" ")} succeeded`);
    assert.match(result.stderr, /refused to move refs\/heads\/main/);
    assert.match(result.stderr, /git worktree add -b fix\/<name>/);
    assert.equal(git(shared, "rev-parse", "main"), head);
  }
});

test("main still moves forward through commits, fast-forward pulls, pushes from worktrees and gc", (t) => {
  const { root, shared, git, commit } = sandbox(t);
  commit(shared, "three");
  git(shared, "update-ref", "refs/heads/main", "HEAD");
  git(shared, "push", "-q", "origin", "main");
  git(shared, "worktree", "add", "-q", "-b", "fix/x", join(root, "wt"), "origin/main");
  const worktree = join(root, "wt");
  commit(worktree, "four");
  git(worktree, "push", "-q", "origin", "HEAD:main");
  git(worktree, "update-ref", "refs/heads/fix/x", "HEAD~2");
  git(shared, "pull", "-q", "--ff-only");
  assert.equal(git(shared, "rev-parse", "main"), git(worktree, "rev-parse", "origin/main"));
  git(shared, "pack-refs", "--all");
  git(shared, "gc", "-q");
  assert.equal(git(shared, "symbolic-ref", "HEAD"), "refs/heads/main");
});

test("a plain pull on a diverged main stops instead of rebasing it", (t) => {
  const { root, shared, run, git, commit } = sandbox(t);
  git(root, "clone", "-q", "remote.git", "other");
  commit(join(root, "other"), "theirs");
  git(join(root, "other"), "push", "-q", "origin", "main");
  commit(shared, "ours");
  const ours = git(shared, "rev-parse", "main");
  assert.notEqual(run(shared, "pull", "-q").status, 0);
  assert.equal(git(shared, "rev-parse", "main"), ours);
  assert.equal(git(shared, "symbolic-ref", "HEAD"), "refs/heads/main");
});
