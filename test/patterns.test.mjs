import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../lib/config.mjs";
import { writeGlobalTeams } from "../lib/teams.mjs";
import { BUILT_IN_PATTERNS, createPattern, deletePattern, legacyPattern, listPatterns, validatePattern } from "../lib/patterns.mjs";

function setup(extraProjects = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-patterns-"));
  const root = path.join(home, "repo");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([
    { root, project: "demo", url: "http://127.0.0.1:9", peers: "claude,codex", ...extraProjects },
  ]));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "operator", AI_COLLAB_PEERS: "claude,codex" };
  return { env, cfg: loadConfig(env) };
}

const pair = (overrides = {}) => ({
  name: "pair",
  roles: [
    { id: "lead", responsibility: "Scope it.", harness: "claude" },
    { id: "doer", responsibility: "Do it.", harness: "codex" },
  ],
  handoffs: [
    { from: "lead", to: "doer", on: "scope", required: false },
    { from: "doer", to: "done", on: "finished", required: true },
  ],
  ...overrides,
});

test("the built-in fix-and-review pattern validates", () => {
  const checked = validatePattern(BUILT_IN_PATTERNS["fix-and-review"]);
  assert.deepEqual(checked.roles.map((role) => role.id), ["lead", "implementer", "reviewer"]);
  assert.equal(checked.handoffs.filter((handoff) => handoff.required).length, 2);
  assert.equal(checked.handoffs.find((handoff) => handoff.on === "changes requested").cap, 3);
});

test("validatePattern rejects broken shapes", () => {
  assert.doesNotThrow(() => validatePattern(pair()));
  assert.throws(() => validatePattern(pair({ handoffs: [{ from: "lead", to: "doer", on: "scope", required: false }] })), /handoff to "done"/);
  assert.throws(() => validatePattern(pair({ roles: [
    { id: "lead", responsibility: "a", harness: "claude" },
    { id: "doer", responsibility: "b", harness: "codex" },
    { id: "idle", responsibility: "c", harness: "codex" },
  ] })), /"idle" is not reachable/);
  assert.throws(() => validatePattern(pair({ roles: [{ id: "lead", responsibility: "a", harness: "mallory" }, { id: "doer", responsibility: "b", harness: "codex" }] })), /harness must be one of/);
  assert.throws(() => validatePattern(pair({ handoffs: [
    { from: "lead", to: "doer", on: "scope", required: false },
    { from: "lead", to: "done", on: "scope", required: false },
    { from: "doer", to: "done", on: "finished", required: true },
  ] })), /two handoffs on "scope"/);
  assert.throws(() => validatePattern(pair({ handoffs: [
    { from: "lead", to: "doer", on: "scope", required: false },
    { from: "doer", to: "done", on: "finished", required: true, cap: 2 },
  ] })), /cap must be an integer/);
  assert.throws(() => validatePattern(pair({ handoffs: [
    { from: "lead", to: "doer", on: "scope", required: "yes" },
    { from: "doer", to: "done", on: "finished", required: true },
  ] })), /required true or false/);
  assert.throws(() => validatePattern(pair({ name: "operator" }), ["operator"]), /reserved/);
});

test("legacyPattern turns each team member into one role without handoffs", () => {
  const legacy = legacyPattern("light", ["codex", "claude:haiku"]);
  assert.equal(legacy.legacy, true);
  assert.deepEqual(legacy.roles.map((role) => [role.id, role.harness, role.model]), [["codex-1", "codex", undefined], ["claude-2", "claude", "haiku"]]);
  assert.deepEqual(legacy.handoffs, []);
});

test("listPatterns merges built-in, global, project and team entries", () => {
  const { env, cfg } = setup({ patterns: { mine: pair({ name: "mine" }) } });
  writeGlobalTeams(env, { crew: ["codex"] });
  const all = listPatterns(cfg, env);
  assert.equal(all["fix-and-review"].source, "built-in");
  assert.equal(all.mine.source, "project");
  assert.equal(all.crew.source, "team");
  assert.equal(all.crew.legacy, true);
});

test("createPattern saves to the project and deletePattern removes it", async () => {
  const { env, cfg } = setup();
  const saved = await createPattern(cfg, pair(), env, { codex: ["gpt-5"] });
  assert.equal(saved.name, "pair");
  const file = JSON.parse(readFileSync(path.join(env.XDG_CONFIG_HOME, "ai-collab", "projects.json"), "utf8"));
  assert.equal(file[0].patterns.pair.roles[1].harness, "codex");
  assert.equal(listPatterns(cfg, env).pair.source, "project");
  assert.deepEqual(deletePattern(cfg, "pair", env), { deleted: "pair" });
  assert.equal(listPatterns(cfg, env).pair, undefined);
});

test("createPattern rejects a team name and an unknown model", async () => {
  const { env, cfg } = setup();
  writeGlobalTeams(env, { crew: ["codex"] });
  await assert.rejects(createPattern(cfg, pair({ name: "crew" }), env), /is a team name/);
  const model = pair({ roles: [{ id: "lead", responsibility: "a", harness: "codex", model: "gpt-x" }, { id: "doer", responsibility: "b", harness: "codex" }], handoffs: [
    { from: "lead", to: "doer", on: "scope", required: false },
    { from: "doer", to: "done", on: "finished", required: true },
  ] });
  await assert.rejects(createPattern(cfg, model, env, { codex: ["gpt-5"] }), /unknown model/);
});

test("deletePattern refuses built-in patterns", () => {
  const { env, cfg } = setup();
  assert.throws(() => deletePattern(cfg, "fix-and-review", env), /is built-in/);
});
