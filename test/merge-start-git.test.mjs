import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { merge } from "../lib/merge-cli.mjs";

// Real git against a temp bare origin; only npm is stubbed.
function sandbox(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "merge-start-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  };
  const git = (cwd, ...args) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const write = (cwd, file, text) => writeFileSync(join(cwd, file), text);
  const commit = (cwd, file, text) => {
    write(cwd, file, text);
    git(cwd, "add", file);
    git(cwd, "commit", "-q", "-m", `edit ${file}`);
    return git(cwd, "rev-parse", "HEAD");
  };
  git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(root, "clone", "-q", "origin.git", "seed");
  commit(join(root, "seed"), "shared.txt", "base\n");
  git(join(root, "seed"), "push", "-q", "origin", "main");
  git(root, "clone", "-q", "origin.git", "ai-collab");
  const host = join(root, "ai-collab");
  // Origin moves after the host cloned, so local main is stale: the merge must start from origin/main.
  const originTip = commit(join(root, "seed"), "other.txt", "landed elsewhere\n");
  git(join(root, "seed"), "push", "-q", "origin", "main");
  const remoteMain = () => git(root, "ls-remote", join(root, "origin.git"), "refs/heads/main").split("\t")[0];

  function start(branches, { gate = 0, run } = {}) {
    let output = "";
    let errors = "";
    const npm = [];
    const status = merge(["start", ...branches], {
      env, hostCheckout: host, tempRoot: root,
      out: { write: (message) => { output += message; } },
      err: { write: (message) => { errors += message; } },
      run(file, argv, options) {
        if (file !== "git") {
          npm.push(argv.at(-1));
          return { status: argv.at(-1) === "test" ? gate : 0, stdout: "" };
        }
        return (run ?? spawnSync)(file, argv, options);
      },
    });
    const lines = output.trim().split("\n");
    return { status, output, errors, npm, result: lines.find((line) => line.startsWith("merge: ")) };
  }
  const worktrees = () => readdirSync(root).filter((name) => name.startsWith("ai-collab-wt-merge-"));
  return { root, host, git, write, commit, originTip, remoteMain, start, worktrees };
}

test("merge start lands a branch on origin/main, verifies the push, pulls the host and cleans up", (t) => {
  const { host, git, commit, originTip, remoteMain, start, worktrees } = sandbox(t);
  git(host, "switch", "-q", "-c", "builder/a");
  const builder = commit(host, "a.txt", "a\n");
  git(host, "switch", "-q", "main");
  const run = start(["builder/a"]);
  assert.equal(run.status, 0, run.errors);
  assert.deepEqual(run.npm, ["ci", "test"]);
  const merged = remoteMain();
  assert.equal(run.result, `merge: merged ${merged} (builder/a); host pulled`);
  assert.deepEqual(git(host, "rev-list", "--parents", "-n1", merged).split(" ").slice(1), [originTip, builder]);
  assert.equal(git(host, "rev-parse", "main"), merged);
  assert.deepEqual(worktrees(), []);
  assert.equal(git(host, "branch", "--list", "merge/*"), "");
});

test("merge start merges several branches in order", (t) => {
  const { host, git, commit, remoteMain, start } = sandbox(t);
  for (const name of ["a", "b"]) {
    git(host, "switch", "-q", "-c", `builder/${name}`, "main");
    commit(host, `${name}.txt`, `${name}\n`);
  }
  git(host, "switch", "-q", "main");
  const run = start(["builder/a", "builder/b"]);
  assert.equal(run.status, 0, run.errors);
  assert.match(run.result, /^merge: merged [0-9a-f]{40} \(builder\/a builder\/b\); host pulled$/);
  assert.equal(git(host, "show", `${remoteMain()}:b.txt`), "b");
});

test("a conflict pushes nothing and reports the refusal", (t) => {
  const { host, git, commit, remoteMain, start, worktrees } = sandbox(t);
  const before = remoteMain();
  git(host, "switch", "-q", "-c", "builder/clash");
  commit(host, "other.txt", "conflicting\n");
  git(host, "switch", "-q", "main");
  const run = start(["builder/clash"]);
  assert.equal(run.status, 1);
  assert.match(run.result, /^merge: refused: builder\/clash does not merge cleanly onto origin\/main/);
  assert.deepEqual(run.npm, []);
  assert.equal(remoteMain(), before);
  assert.equal(worktrees().length, 1);
});

test("a red gate pushes nothing", (t) => {
  const { host, git, commit, remoteMain, start } = sandbox(t);
  const before = remoteMain();
  git(host, "switch", "-q", "-c", "builder/red");
  commit(host, "a.txt", "a\n");
  git(host, "switch", "-q", "main");
  const run = start(["builder/red"], { gate: 1 });
  assert.equal(run.status, 1);
  assert.match(run.result, /^merge: refused: npm test failed/);
  assert.equal(remoteMain(), before);
});

test("a push that origin does not show is reported as refused, not merged", (t) => {
  const { host, git, commit, remoteMain, start } = sandbox(t);
  const before = remoteMain();
  git(host, "switch", "-q", "-c", "builder/a");
  commit(host, "a.txt", "a\n");
  git(host, "switch", "-q", "main");
  const run = start(["builder/a"], {
    run: (file, argv, options) => argv.includes("push") ? { status: 0, stdout: "" } : spawnSync(file, argv, options),
  });
  assert.equal(run.status, 1);
  assert.match(run.result, new RegExp(`^merge: refused: origin main is ${before}, not the pushed [0-9a-f]{40}`));
});

test("local edits that block the host pull are reported and left alone", (t) => {
  const { host, git, write, commit, remoteMain, start, worktrees } = sandbox(t);
  git(host, "switch", "-q", "-c", "builder/a");
  commit(host, "a.txt", "a\n");
  git(host, "switch", "-q", "main");
  const stale = git(host, "rev-parse", "main");
  write(host, "other.txt", "someone else's uncommitted edit\n");
  const run = start(["builder/a"]);
  assert.equal(run.status, 0, run.errors);
  const merged = remoteMain();
  assert.match(run.result, new RegExp(`^merge: merged ${merged} \\(builder/a\\); host pull skipped: `));
  assert.equal(git(host, "rev-parse", "main"), stale);
  assert.equal(readFileSync(join(host, "other.txt"), "utf8"), "someone else's uncommitted edit\n");
  assert.deepEqual(worktrees(), []);
  assert.equal(existsSync(join(host, ".git", "MERGE_HEAD")), false);
});
