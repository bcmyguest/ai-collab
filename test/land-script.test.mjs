import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { landBranch } from "../tools/land.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const GATE = ["ci", "run typecheck", "run lint", "test"];

// Real git against a temp bare origin; npm and the deploy are stubbed.
function sandbox(t) {
  const root = realpathSync(tempDir(t, "land-script-"));
  const env = {
    PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  };
  const git = (cwd, ...args) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = (cwd, file, text) => {
    writeFileSync(join(cwd, file), text);
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
  // Origin moves after the host cloned, so the branch must be rebased onto origin/main, not local main.
  const originTip = commit(join(root, "seed"), "other.txt", "landed elsewhere\n");
  git(join(root, "seed"), "push", "-q", "origin", "main");
  const remoteMain = () => git(root, "ls-remote", join(root, "origin.git"), "refs/heads/main").split("\t")[0];
  const cacheRoot = join(root, "cache");

  function land(args, { failStep, extraEnv = {}, platform = "linux", deployStatus = 0 } = {}) {
    let output = "";
    let errors = "";
    const npm = [];
    const deploys = [];
    const status = landBranch(args, {
      env: { ...env, ...extraEnv }, hostCheckout: host, cacheRoot, platform, npm: ["npm"], nodePath: "/usr/bin/node",
      out: { write: (message) => { output += message; } },
      err: { write: (message) => { errors += message; } },
      run(file, argv, options) {
        if (file === "npm") {
          const step = argv.join(" ");
          npm.push({ step, cwd: options.cwd, home: options.env.HOME });
          return { status: step === failStep ? 1 : 0, stdout: "", stderr: "" };
        }
        if (argv.at(-1) === "deploy") {
          deploys.push({ file, argv, cwd: options.cwd });
          return { status: deployStatus, stdout: "", stderr: "" };
        }
        return spawnSync(file, argv, options);
      },
    });
    return { status, output, errors, npm, deploys };
  }
  const worktrees = () => readdirSync(cacheRoot).filter((name) => name.startsWith("wt-"));
  return { host, git, commit, originTip, remoteMain, cacheRoot, land, worktrees };
}

test("land rebases the branch onto origin/main, gates it, pushes main and deploys the host", (t) => {
  const { host, git, commit, originTip, remoteMain, cacheRoot, land, worktrees } = sandbox(t);
  git(host, "switch", "-q", "-c", "feat/a");
  commit(host, "a.txt", "a\n");
  git(host, "switch", "-q", "main");
  const run = land(["feat/a"]);
  assert.equal(run.status, 0, run.output + run.errors);
  assert.deepEqual(run.npm.map(({ step }) => step), GATE);
  assert.ok(run.npm.every(({ cwd, home }) => cwd.startsWith(cacheRoot) && home.startsWith(cacheRoot)));
  const landed = remoteMain();
  // A rebase keeps history linear: the landed commit's only parent is the origin tip.
  assert.deepEqual(git(host, "rev-list", "--parents", "-n1", landed).split(" ").slice(1), [originTip]);
  assert.match(run.output, new RegExp(`land: landed ${landed} \\(feat/a\\) on main`));
  assert.deepEqual(run.deploys.map(({ argv, cwd }) => [argv.slice(-2), cwd]), [[[join(host, "scripts/ai-collab.mjs"), "deploy"], host]]);
  assert.deepEqual(worktrees(), []);
});

test("land pushes nothing and deploys nothing when a gate step fails", (t) => {
  const { host, git, commit, originTip, remoteMain, land } = sandbox(t);
  git(host, "switch", "-q", "-c", "feat/red");
  commit(host, "red.txt", "red\n");
  git(host, "switch", "-q", "main");
  const run = land(["feat/red"], { failStep: "run lint" });
  assert.equal(run.status, 1);
  assert.deepEqual(run.npm.map(({ step }) => step), ["ci", "run typecheck", "run lint"]);
  assert.match(run.output, /land: refused: npm run lint failed \(1\); nothing pushed; gate log: /);
  assert.equal(remoteMain(), originTip);
  assert.deepEqual(run.deploys, []);
});

test("land refuses a branch that does not rebase cleanly", (t) => {
  const { host, git, commit, originTip, remoteMain, land } = sandbox(t);
  git(host, "switch", "-q", "-c", "feat/conflict");
  commit(host, "other.txt", "conflicting\n");
  git(host, "switch", "-q", "main");
  const run = land(["feat/conflict"]);
  assert.equal(run.status, 1);
  assert.match(run.output, /land: refused: feat\/conflict does not rebase cleanly onto origin\/main; nothing pushed/);
  assert.deepEqual(run.npm, []);
  assert.equal(remoteMain(), originTip);
});

test("land refuses inside an agent session, off Linux, and for main", (t) => {
  const { originTip, remoteMain, land } = sandbox(t);
  const session = land(["feat/a"], { extraEnv: { AI_COLLAB_SESSION: "claude#x" } });
  assert.equal(session.status, 1);
  assert.match(session.errors, /not inside an agent session/);
  const mac = land(["feat/a"], { platform: "darwin" });
  assert.equal(mac.status, 1);
  assert.match(mac.errors, /Linux only/);
  const main = land(["main"]);
  assert.equal(main.status, 1);
  for (const run of [session, mac, main]) assert.deepEqual([run.npm, run.deploys], [[], []]);
  assert.equal(remoteMain(), originTip);
});

test("land reports a failed deploy after main is pushed", (t) => {
  const { host, git, commit, originTip, remoteMain, land } = sandbox(t);
  git(host, "switch", "-q", "-c", "feat/deploy");
  commit(host, "d.txt", "d\n");
  git(host, "switch", "-q", "main");
  const run = land(["feat/deploy"], { deployStatus: 3 });
  assert.equal(run.status, 1);
  assert.notEqual(remoteMain(), originTip);
  assert.match(run.errors, /land: deploy failed \(3\)/);
});
