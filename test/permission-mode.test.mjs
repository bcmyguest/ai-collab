import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { claudePermissionSetting } from "../lib/config.mjs";
import { claudePermissionFor, startSession } from "../lib/start.mjs";
import { runnerModeOfClaude } from "../runner/contract.mjs";
import { tempDir } from "./helpers/tmp.mjs";

// A config dir holding defaults.json (when given) and projects.json for one project rooted at a real folder.
function fixture(defaults) {
  const xdg = tempDir({ after }, "perm-xdg-");
  const root = tempDir({ after }, "perm-root-");
  const stateDir = tempDir({ after }, "perm-state-");
  mkdirSync(path.join(xdg, "ai-collab"), { recursive: true });
  writeFileSync(path.join(xdg, "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  if (defaults !== undefined) writeFileSync(path.join(xdg, "ai-collab", "defaults.json"), JSON.stringify(defaults));
  return { env: { XDG_CONFIG_HOME: xdg }, cfg: { project: "demo", stateDir } };
}

// Records the AFK mode this machine read for the project, the way lib/mode.ts stores it.
function recordAfk({ cfg }, mode) {
  const dir = path.join(cfg.stateDir, cfg.project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "operator-mode.json"), JSON.stringify({ mode, ts: Date.now() }));
}

test("claudePermissionMode defaults to default and accepts each CLI value, auto-afk and inherit", () => {
  assert.deepEqual(claudePermissionSetting(fixture().env), { mode: "default" });
  for (const mode of ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan", "auto-afk", "inherit"]) {
    assert.deepEqual(claudePermissionSetting(fixture({ claudePermissionMode: mode }).env), { mode });
  }
});

test("an invalid claudePermissionMode is refused with the valid values named", () => {
  const { error } = claudePermissionSetting(fixture({ claudePermissionMode: "yolo" }).env);
  assert.match(error, /claudePermissionMode must be one of auto-afk, inherit, acceptEdits, auto, bypassPermissions, default, dontAsk, plan/);
  assert.match(error, /got "yolo"/);
});

test("the default passes default whatever the AFK state", () => {
  const f = fixture();
  assert.deepEqual(claudePermissionFor("claude", f.cfg, f.env), { flag: "default" });
  recordAfk(f, "on");
  assert.deepEqual(claudePermissionFor("claude", f.cfg, f.env), { flag: "default" });
});

test("auto-afk passes default only while AFK is on for the project", () => {
  const f = fixture({ claudePermissionMode: "auto-afk" });
  assert.deepEqual(claudePermissionFor("claude", f.cfg, f.env), { flag: undefined });
  recordAfk(f, "on");
  assert.deepEqual(claudePermissionFor("claude", f.cfg, f.env), { flag: "default" });
  recordAfk(f, "quiet");
  assert.deepEqual(claudePermissionFor("claude", f.cfg, f.env), { flag: "default" });
  recordAfk(f, "off");
  assert.deepEqual(claudePermissionFor("claude", f.cfg, f.env), { flag: undefined });
});

test("bypassPermissions is refused on the host unless the start is sandboxed or allowed", () => {
  const f = fixture({ claudePermissionMode: "bypassPermissions" });
  const refused = claudePermissionFor("claude", f.cfg, f.env);
  assert.equal(refused.flag, undefined);
  assert.match(refused.error, /bypassPermissions runs only in openshell; set AI_COLLAB_ALLOW_HOST_AGENT=1/);
  assert.deepEqual(claudePermissionFor("claude", f.cfg, f.env, { sandboxed: true }), { flag: "bypassPermissions" });
  assert.deepEqual(claudePermissionFor("claude", f.cfg, { ...f.env, AI_COLLAB_ALLOW_HOST_AGENT: "1" }), { flag: "bypassPermissions" });
});

test("a host start refuses bypassPermissions with the same message the runner gives", async () => {
  const f = fixture({ claudePermissionMode: "bypassPermissions" });
  const started = await startSession(f.cfg, { harness: "claude", prompt: "hi", env: f.env, run: () => { throw new Error("must not spawn"); } });
  assert.equal(started.status, "failed");
  assert.equal(started.detail, claudePermissionFor("claude", f.cfg, f.env).error);
});

test("inherit passes no flag whatever the AFK state", () => {
  const f = fixture({ claudePermissionMode: "inherit" });
  assert.deepEqual(claudePermissionFor("claude", f.cfg, f.env), { flag: undefined });
  recordAfk(f, "on");
  assert.deepEqual(claudePermissionFor("claude", f.cfg, f.env), { flag: undefined });
});

test("a concrete mode passes whatever the AFK state", () => {
  const f = fixture({ claudePermissionMode: "acceptEdits" });
  assert.deepEqual(claudePermissionFor("claude", f.cfg, f.env), { flag: "acceptEdits" });
  recordAfk(f, "on");
  assert.deepEqual(claudePermissionFor("claude", f.cfg, f.env), { flag: "acceptEdits" });
});

test("other harnesses get no permission flag, and an invalid setting refuses the start", async () => {
  const f = fixture({ claudePermissionMode: "bogus" });
  assert.deepEqual(claudePermissionFor("codex", f.cfg, f.env), {});
  const started = await startSession({ ...f.cfg, root: "" }, {
    harness: "claude", prompt: "hi", env: f.env, run: () => { throw new Error("must not spawn"); },
  });
  assert.equal(started.status, "failed");
  assert.match(started.detail, /claudePermissionMode/);
});

test("the runner maps the Claude modes it names and has no mode for dontAsk or plan", () => {
  assert.equal(runnerModeOfClaude("default"), "supervised");
  assert.equal(runnerModeOfClaude("acceptEdits"), "accept-edits");
  assert.equal(runnerModeOfClaude("auto"), "auto");
  assert.equal(runnerModeOfClaude("bypassPermissions"), "full-access");
  assert.equal(runnerModeOfClaude("dontAsk"), null);
  assert.equal(runnerModeOfClaude("plan"), null);
  assert.equal(runnerModeOfClaude("constructor"), null);
});
