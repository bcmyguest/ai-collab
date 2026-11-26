import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stateDir } from "../lib/config.mjs";
import { pruneRepo } from "../lib/prune.mjs";

const NOW = Date.parse("2026-11-25T00:00:00Z");
const WEEK = 7 * 86_400_000;
const OLD_ISO = "2026-01-01T00:00:00Z";
const OLD = Date.parse(OLD_ISO) / 1000;
const IDENTITY_KEYS = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"];

// An env where git cannot name a committer: no global or system config, no identity variables, no auto-detection.
function noIdentityEnv(home) {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.useConfigOnly", GIT_CONFIG_VALUE_0: "true" };
  for (const key of [...IDENTITY_KEYS, "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  return env;
}

function git(cwd, args, env) {
  return execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" }).trim();
}

test("prune archives a dirty builder clone on a host with no git identity", async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-prune-ident-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const systemctl = path.join(home, "fake-systemctl");
  writeFileSync(systemctl, "#!/bin/sh\necho inactive\n");
  chmodSync(systemctl, 0o755);
  const env = { ...noIdentityEnv(home), AI_COLLAB_STATE_DIR: path.join(home, "state"), AI_COLLAB_SYSTEMCTL_BIN: systemctl };
  const setup = { ...env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_AUTHOR_DATE: OLD_ISO, GIT_COMMITTER_DATE: OLD_ISO };
  assert.throws(() => git(home, ["var", "GIT_COMMITTER_IDENT"], env), "the fixture env must leave git without an identity");
  const repo = path.join(home, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"], setup);
  writeFileSync(path.join(repo, "notes.md"), "# notes\n");
  git(repo, ["add", "notes.md"], setup);
  git(repo, ["commit", "-q", "-m", "init"], setup);
  const dir = path.join(stateDir(env), "builders", "b1");
  const clone = path.join(dir, "back", "ai-collab-wt-b1");
  mkdirSync(clone, { recursive: true });
  git(clone, ["init", "-q", "-b", "work"], setup);
  writeFileSync(path.join(clone, "a.txt"), "a\n");
  git(clone, ["add", "a.txt"], setup);
  git(clone, ["commit", "-q", "-m", "a"], setup);
  const workSha = git(clone, ["rev-parse", "HEAD"], setup);
  writeFileSync(path.join(clone, "uncommitted.txt"), "x\n");
  const state = path.join(dir, "state.json");
  writeFileSync(state, JSON.stringify({ id: "b1", phase: "failed", commits: 0, root: repo, worktree: path.join(home, "ai-collab-wt-b1") }));
  utimesSync(state, OLD, OLD);

  const summary = await pruneRepo({ env, root: repo, olderThanMs: WEEK, apply: true, now: NOW });

  assert.deepEqual(summary.builders.map((b) => b.id), ["b1"], JSON.stringify(summary.skipped));
  const archived = git(repo, ["rev-parse", "refs/ai-collab/archive/b1/HEAD"], setup);
  assert.equal(git(repo, ["cat-file", "-p", `${archived}:uncommitted.txt`], setup), "x");
  assert.equal(git(repo, ["rev-list", "--count", `${workSha}..${archived}`], setup), "1");
  assert.equal(git(repo, ["log", "-1", "--format=%cn <%ce>", archived], setup), "ai-collab <ai-collab@localhost>");
});
