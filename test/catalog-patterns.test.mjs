import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { loadConfig } from "../lib/config.ts";
import { getPattern, listPatterns, savePattern } from "../lib/catalog/patterns.ts";
import { writeGlobalTeams } from "../lib/catalog/teams.ts";
import { tempDir } from "./helpers/tmp.mjs";

function setup({ teams = {}, globalTeams = {} } = {}) {
  const home = tempDir({ after }, "ai-collab-catalog-patterns-");
  const root = path.join(home, "repo");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([
    { root, project: "demo", url: "http://127.0.0.1:9", peers: "claude,codex", teams },
  ]));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "operator", AI_COLLAB_PEERS: "claude,codex" };
  writeGlobalTeams(env, globalTeams);
  return { env, cfg: loadConfig(env), root };
}

test("a legacy project team with a bad member lists as invalid and does not throw", () => {
  const { env, cfg } = setup({ teams: { crew: ["claude", "mallory"], good: ["claude"] } });
  const all = listPatterns(cfg, env);
  assert.equal(all.crew.source, "team");
  assert.equal(all.crew.invalid, 'team member "mallory" is not a harness or harness:model');
  assert.deepEqual(all.crew.roles, []);
  assert.equal(all.good.invalid, undefined);
  assert.deepEqual(all.good.roles.map((role) => role.harness), ["claude"]);
  assert.throws(() => getPattern(cfg, "crew", env), /pattern "crew" is invalid: team member "mallory"/);
});

test("a legacy global team with a bad member lists as invalid and does not throw", () => {
  const { env, cfg } = setup({ globalTeams: { wide: ["codex:gpt-5", "nobody"] } });
  const entry = listPatterns(cfg, env).wide;
  assert.equal(entry.source, "team");
  assert.match(entry.invalid, /team member "nobody" is not a harness or harness:model/);
});

test("a legacy team of valid members reads as one role per member with no handoffs", () => {
  const { env, cfg } = setup({ teams: { pair: ["claude", "codex:gpt-5"] } });
  const entry = getPattern(cfg, "pair", env);
  assert.equal(entry.legacy, true);
  assert.deepEqual(entry.roles, [
    { id: "claude-1", responsibility: "", harness: "claude" },
    { id: "codex-2", responsibility: "", harness: "codex", model: "gpt-5" },
  ]);
  assert.deepEqual(entry.handoffs, []);
});

test("savePattern on a project pattern rewrites projects.json and leaves other entries alone", async () => {
  const { env, cfg, root } = setup();
  const file = path.join(env.XDG_CONFIG_HOME, "ai-collab", "projects.json");
  const pattern = {
    name: "pair",
    roles: [{ id: "lead", responsibility: "Scope it.", harness: "claude" }],
    handoffs: [{ from: "lead", to: "done", on: "finished", required: true }],
  };
  await savePattern(cfg, pattern, {}, env, {});
  const renamed = { ...pattern, name: "duo", description: "One role." };
  await savePattern(cfg, renamed, { replace: "pair" }, env, {});
  const [entry] = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(entry.root, root);
  assert.deepEqual(Object.keys(entry.patterns), ["duo"]);
  assert.equal(entry.patterns.duo.description, "One role.");
  assert.deepEqual(entry.teams, {});
});

test("savePattern refuses a global legacy team, which lives in teams.json", async () => {
  const { env, cfg } = setup({ globalTeams: { wide: ["codex"] } });
  const pattern = { name: "wide", roles: [{ id: "lead", responsibility: "Go.", harness: "claude" }], handoffs: [{ from: "lead", to: "done", on: "done", required: true }] };
  await assert.rejects(savePattern(cfg, pattern, { replace: "wide" }, env, {}), /team "wide" is global; edit it in teams.json/);
});
