import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gitRoot, listProjects, loadConfig, loadProjects, projectName, sessionLabel } from "../lib/config.mjs";
import { recordSession } from "../lib/sessions.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const SESSION_ID = "0123456789abcdef-session";

function home({ defaults = true } = {}) {
  const dir = tempDir({ after }, "ai-collab-auto-");
  const token = path.join(dir, "token");
  writeFileSync(token, "tk_test");
  mkdirSync(path.join(dir, ".config", "ai-collab"), { recursive: true });
  if (defaults) writeFileSync(path.join(dir, ".config", "ai-collab", "defaults.json"), JSON.stringify({ url: "http://127.0.0.1:9", tokenFile: token, peers: "claude,codex" }));
  const repo = path.join(dir, "code", "My_Repo.v2");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
  return { env: { HOME: dir }, dir, repo };
}

test("folder names become project names within the name rules", () => {
  assert.equal(projectName("My_Repo.v2"), "my-repo-v2");
  assert.equal(projectName("--x--"), "x");
  assert.equal(projectName("a".repeat(30)), "a".repeat(24));
  assert.equal(projectName("..."), "");
});

test("gitRoot finds the repo from a subfolder and maps a linked worktree to its main repo", () => {
  const { dir, repo } = home();
  assert.equal(gitRoot(path.join(repo, "src", "deep")), repo);
  const linked = path.join(dir, "wt");
  mkdirSync(linked);
  writeFileSync(path.join(linked, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "wt")}\n`);
  assert.equal(gitRoot(linked), repo);
  assert.equal(gitRoot(dir), "");
});

test("any git repo joins under its folder name when defaults.json exists", () => {
  const { env, repo } = home();
  const cfg = loadConfig(env, { cwd: path.join(repo, "src"), host: "claude" });
  assert.equal(cfg.enabled, true, cfg.reason);
  assert.equal(cfg.project, "my-repo-v2");
  assert.equal(cfg.peer, "claude");
  assert.equal(cfg.token, "tk_test");
  assert.deepEqual(cfg.peers, ["claude", "codex"]);
  assert.equal(cfg.root, repo);
  assert.equal(cfg.auto, true);
});

test("no defaults.json, a .ai-collab-off file, or a non-repo folder keeps the session out", () => {
  assert.equal(loadConfig(home({ defaults: false }).env, { cwd: home({ defaults: false }).repo, host: "claude" }).enabled, false);
  const { env, repo, dir } = home();
  assert.equal(loadConfig(env, { cwd: dir, host: "claude" }).enabled, false);
  writeFileSync(path.join(repo, ".ai-collab-off"), "");
  assert.equal(loadConfig(env, { cwd: repo, host: "claude" }).enabled, false);
});

test("a projects.json entry wins over auto-join for its folder", () => {
  const { env, repo, dir } = home();
  writeFileSync(path.join(dir, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root: repo, project: "named", url: "http://127.0.0.1:9", tokenFile: path.join(dir, "token") }]));
  const cfg = loadConfig(env, { cwd: repo, host: "codex" });
  assert.equal(cfg.project, "named");
  assert.equal(cfg.auto, undefined);
});

test("a recorded session lists its auto-joined repo for the UI and phone starts", async () => {
  const { env, repo } = home();
  const session = sessionLabel(SESSION_ID);
  const cfg = loadConfig(env, { cwd: repo, host: "claude", session });
  assert.deepEqual(listProjects(env), []);
  await recordSession(cfg, { id: SESSION_ID, cwd: repo, harness: "claude", event: "SessionStart" });
  assert.deepEqual(listProjects(env).map(p => [p.project, p.root, p.auto]), [["my-repo-v2", repo, true]]);
  assert.deepEqual(loadProjects(env, { host: "operator" }).map(p => [p.project, p.peer]), [["my-repo-v2", "operator"]]);
});
