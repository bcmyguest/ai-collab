import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, after } from "node:test";
import { sessionLabel } from "../lib/config.mjs";
import { harnessCommand } from "../lib/sessions/control.ts";
import { nextPermission, readOwned, setNextPermission, writeOwned } from "../lib/sessions/registry.ts";
import { slashCommand } from "../lib/slash.ts";
import { requestTeamPermission } from "../lib/team-permission.ts";
import { tempDir } from "./helpers/tmp.mjs";

const UUID = "6f1d2c3a-4b5e-4f60-8a7b-9c0d1e2f3a4b";
const ID = `claude#${sessionLabel(UUID)}`;

function project() {
  const stateDir = tempDir({ after }, "perm-cmd-");
  const cfg = { project: "demo", stateDir, peer: "claude", peers: [] };
  mkdirSync(path.join(stateDir, "demo", "registry"), { recursive: true });
  return cfg;
}

// A registry entry for a session the way recordSession writes it: its id is the address.
function registerSession(cfg, { sandbox = false, claudePermission } = {}) {
  const file = path.join(cfg.stateDir, cfg.project, "registry", `${ID}.json`);
  writeFileSync(file, JSON.stringify({ id: ID, sessionId: UUID, cwd: cfg.stateDir, harness: "claude", sandbox, ...(claudePermission ? { claudePermission } : {}) }));
  return file;
}

const peer = (extra = {}) => ({ id: ID, harness: "claude", sessionId: UUID, cwd: os.tmpdir(), ...extra });

test("the next-start value goes to the owned record for a runner session, else the registry entry", async () => {
  const cfg = project();
  const label = sessionLabel(UUID);
  writeOwned(cfg, { label, status: "ended", nativeId: UUID });
  assert.equal(await setNextPermission(cfg, { id: ID, label, value: "dontAsk" }), "owned");
  assert.equal(readOwned(cfg, label).claudePermission, "dontAsk");
  assert.equal(nextPermission(cfg, { id: ID, label }), "dontAsk");

  const direct = project();
  const file = registerSession(direct);
  assert.equal(await setNextPermission(direct, { id: ID, label, value: "acceptEdits" }), "registry");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).claudePermission, "acceptEdits");
  assert.equal(nextPermission(direct, { id: ID, label }), "acceptEdits");
});

test("the runner's record wins over the registry, and an unregistered session is refused", async () => {
  const cfg = project();
  const label = sessionLabel(UUID);
  registerSession(cfg, { claudePermission: "dontAsk" });
  writeOwned(cfg, { label, status: "ended", nativeId: UUID, claudePermission: "plan" });
  assert.equal(nextPermission(cfg, { id: ID, label }), "plan");
  await assert.rejects(setNextPermission(cfg, { id: `claude#${sessionLabel("other")}`, label: sessionLabel("other"), value: "auto" }), /Unknown session/);
});

test("a stored permission reaches the wake argv; without one the wake passes no flag", () => {
  const plain = harnessCommand("wake", "claude", UUID, false, { path: "" });
  assert.equal(plain[1].includes("--permission-mode"), false);
  assert.deepEqual(plain[1].slice(0, 3), ["--print", "--resume", UUID]);
  const woken = harnessCommand("wake", "claude", UUID, false, { path: "", permission: "dontAsk" });
  assert.deepEqual(woken[1].slice(0, 5), ["--print", "--resume", UUID, "--permission-mode", "dontAsk"]);
});

test("/permission stores a valid mode and reports where it went", async () => {
  const seen = [];
  const reply = await slashCommand(peer(), { name: "permission", args: "dontAsk" }, { setPermission: async (p, mode) => { seen.push([p.id, mode]); return "registry"; } });
  assert.equal(reply.status, "succeeded");
  assert.match(reply.detail, /next start or wake of this session uses dontAsk \(session registry\)/);
  assert.deepEqual(seen, [[ID, "dontAsk"]]);
});

test("/permission refuses an invalid mode and bypassPermissions outside OpenShell, and runs nothing", async () => {
  let called = false;
  const setPermission = async () => { called = true; return "registry"; };
  const bad = await slashCommand(peer(), { name: "permission", args: "yolo" }, { setPermission });
  assert.equal(bad.status, "failed");
  assert.match(bad.detail, /claudePermissionMode must be one of/);
  const bypass = await slashCommand(peer(), { name: "permission", args: "bypassPermissions" }, { setPermission });
  assert.equal(bypass.status, "failed");
  assert.match(bypass.detail, /bypassPermissions runs only in openshell; set AI_COLLAB_ALLOW_HOST_AGENT=1/);
  assert.equal(called, false);
  const inBox = await slashCommand(peer({ sandbox: true }), { name: "permission", args: "bypassPermissions" }, { setPermission });
  assert.equal(inBox.status, "succeeded", "an OpenShell session may take bypassPermissions");
});

test("/permission is for Claude sessions; /team-permission validates both words and needs a team store", async () => {
  const codex = await slashCommand(peer({ harness: "codex" }), { name: "permission", args: "default" }, { setPermission: async () => "registry" });
  assert.equal(codex.status, "unsupported");
  const missing = await slashCommand(peer(), { name: "team-permission", args: "build" }, {});
  assert.equal(missing.status, "failed");
  assert.match(missing.detail, /Use \/team-permission <team> <mode>/);
  const unknown = await slashCommand(peer(), { name: "team-permission", args: "build nope" }, { askTeamPermission: () => ({ status: "pending" }) });
  assert.match(unknown.detail, /claudePermissionMode must be one of/);
  const asked = [];
  const sent = await slashCommand(peer(), { name: "team-permission", args: "build dontAsk" }, { askTeamPermission: (team, mode) => { asked.push([team, mode]); return { status: "pending" }; } });
  assert.equal(sent.status, "pending");
  assert.deepEqual(asked, [["build", "dontAsk"]]);
});

// The DOT team the confirmation rewrites; its permission attribute is the only change.
const TEAM = `digraph "build" {
  "lead" [agent="codex", prompt="Scope it."];
  "doer" [agent="claude", prompt="Do it."];
  "lead" -> "doer" [on="scope"];
  "doer" -> "done" [on="finished"];
}`;

function teamFile(dir) {
  const file = path.join(dir, "team.dot");
  writeFileSync(file, TEAM);
  return file;
}

test("/team-permission writes the attribute only when the operator taps Apply", async (t) => {
  const dir = tempDir(t, "perm-team-");
  const file = teamFile(dir);
  const pattern = () => ({ name: "build", file });
  const saved = [];
  const save = async (name, text) => { saved.push([name, text]); writeFileSync(file, text); };
  const asked = [];
  const ask = async (cfg, question, options) => { asked.push([question, options.choices]); return { id: "q1", status: "answered", answer: "Apply" }; };
  const result = requestTeamPermission({ project: "demo" }, "build", "dontAsk", { pattern, save, ask });
  assert.equal(result.status, "pending");
  await result.done;
  assert.deepEqual(asked.map((item) => item[1]), [["Apply", "Cancel"]]);
  assert.equal(saved.length, 1);
  assert.match(saved[0][1], /graph \[permission="dontAsk"\];/);
});

test("/team-permission leaves team.dot alone on Cancel", async (t) => {
  const dir = tempDir(t, "perm-team-");
  const file = teamFile(dir);
  const before = readFileSync(file, "utf8");
  const saved = [];
  const result = requestTeamPermission({ project: "demo" }, "build", "dontAsk", {
    pattern: () => ({ name: "build", file }),
    save: async (name, text) => saved.push(text),
    ask: async () => ({ id: "q2", status: "answered", answer: "Cancel" }),
  });
  assert.equal(await result.done, "cancelled");
  assert.deepEqual(saved, []);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("/team-permission refuses a team without a team.dot file", () => {
  const result = requestTeamPermission({ project: "demo" }, "reviewers", "dontAsk", {
    pattern: () => ({ name: "reviewers" }),
    ask: async () => { throw new Error("must not ask"); },
  });
  assert.equal(result.status, "failed");
  assert.match(result.detail, /is not a team\.dot team/);
});
