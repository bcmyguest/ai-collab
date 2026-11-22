import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../lib/config.mjs";
import { BUILT_IN_PATTERNS, copyPattern, createPattern, listPatterns, removePattern, savePattern, validatePattern } from "../lib/patterns.mjs";
import { createTeam, listTeams } from "../lib/teams.mjs";

const MODELS = { claude: ["claude-haiku-5-5"], codex: ["gpt-5"], cursor: ["deepseek-v41-flash-1017-high"] };

function setup() {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-pattern-edit-"));
  const root = path.join(home, "repo");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([
    { root, project: "demo", url: "http://127.0.0.1:9", peers: "claude,codex,cursor" },
  ]));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "operator", AI_COLLAB_PEERS: "claude,codex,cursor", AI_COLLAB_URL: "http://127.0.0.1:9" };
  return { env, cfg: loadConfig(env) };
}

const pair = (name, overrides = {}) => ({
  name,
  description: "Doer and checker.",
  roles: [
    { id: "doer", responsibility: "Do the work.", harness: "claude" },
    { id: "checker", responsibility: "Check the work.", harness: "codex" },
  ],
  handoffs: [
    { from: "doer", to: "checker", on: "ready", required: true },
    { from: "checker", to: "done", on: "finished", required: true },
  ],
  ...overrides,
});

test("a saved description is trimmed, optional, and capped at 200 characters", () => {
  assert.equal(validatePattern({ ...pair("pair"), description: "  Scope it.  " }).description, "Scope it.");
  assert.equal("description" in validatePattern({ ...pair("pair"), description: "   " }), false);
  assert.throws(() => validatePattern({ ...pair("pair"), description: "x".repeat(201) }), /at most 200/);
});

test("saving with a replace name updates the project pattern in place", async () => {
  const { env, cfg } = setup();
  await createPattern(cfg, pair("pair"), env, MODELS);
  await savePattern(cfg, pair("pair", { description: "Changed." }), { replace: "pair" }, env, MODELS);
  const all = listPatterns(cfg, env);
  assert.equal(all.pair.description, "Changed.");
  assert.equal(all.pair.source, "project");
  assert.equal(Object.keys(all).filter((name) => name === "pair").length, 1);
});

test("a new name with a replace name renames the pattern and deletes the old one", async () => {
  const { env, cfg } = setup();
  await createPattern(cfg, pair("pair"), env, MODELS);
  await savePattern(cfg, pair("duo"), { replace: "pair" }, env, MODELS);
  const all = listPatterns(cfg, env);
  assert.ok(all.duo);
  assert.equal(all.pair, undefined);
});

test("a rename onto an existing name is refused and leaves both patterns", async () => {
  const { env, cfg } = setup();
  await createPattern(cfg, pair("pair"), env, MODELS);
  await createPattern(cfg, pair("other"), env, MODELS);
  await assert.rejects(savePattern(cfg, pair("other"), { replace: "pair" }, env, MODELS), /already exists/);
  const all = listPatterns(cfg, env);
  assert.ok(all.pair && all.other);
});

test("built-in and unknown patterns are not saved in place", async () => {
  const { env, cfg } = setup();
  await assert.rejects(savePattern(cfg, BUILT_IN_PATTERNS["fix-and-review"], { replace: "fix-and-review" }, env, MODELS), /built-in pattern "fix-and-review" is read-only/);
  await assert.rejects(savePattern(cfg, pair("pair"), { replace: "nope" }, env, MODELS), /unknown pattern "nope"/);
});

test("saving a team's name as a pattern converts the team and removes it", async () => {
  const { env, cfg } = setup();
  await createTeam(cfg, "crew", ["claude", "codex"], env, MODELS);
  const converted = {
    name: "crew",
    roles: [{ id: "lead", responsibility: "Lead the crew.", harness: "claude" }],
    handoffs: [{ from: "lead", to: "done", on: "finished", required: false }],
  };
  await savePattern(cfg, converted, { replace: "crew" }, env, MODELS);
  assert.equal(listTeams(cfg, env).crew, undefined);
  const crew = listPatterns(cfg, env).crew;
  assert.equal(crew.source, "project");
  assert.equal(crew.legacy, undefined);
  assert.deepEqual(crew.roles.map((role) => role.id), ["lead"]);
});

test("copyPattern puts a built-in pattern in the project under its name", async () => {
  const { env, cfg } = setup();
  const copy = await copyPattern(cfg, "fix-and-review", env, MODELS);
  assert.equal(copy.name, "fix-and-review");
  assert.equal(listPatterns(cfg, env)["fix-and-review"].source, "project");
  assert.equal(listPatterns(cfg, env)["fix-and-review"].description, BUILT_IN_PATTERNS["fix-and-review"].description);
  await assert.rejects(copyPattern(cfg, "fix-and-review", env, MODELS), /already project/);
});

test("removePattern deletes a project pattern or a project team", async () => {
  const { env, cfg } = setup();
  await createPattern(cfg, pair("pair"), env, MODELS);
  await createTeam(cfg, "crew", ["claude"], env, MODELS);
  removePattern(cfg, "pair", env);
  removePattern(cfg, "crew", env);
  const all = listPatterns(cfg, env);
  assert.equal(all.pair, undefined);
  assert.equal(all.crew, undefined);
  assert.throws(() => removePattern(cfg, "fix-and-review", env), /is built-in/);
});
