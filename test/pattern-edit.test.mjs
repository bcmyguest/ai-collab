import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { loadConfig } from "../lib/config.ts";
import { BUILT_IN_PATTERNS, copyPattern, createPattern, listPatterns, removableNames, removePattern, savePattern } from "../lib/catalog/patterns.ts";
import { validatePattern } from "../lib/catalog/pattern-model.ts";
import { createTeam } from "../lib/catalog/roster.ts";
import { listTeams } from "../lib/catalog/teams.ts";
import { mentionedTeams } from "../web/lib/message-routing.js";
import { patternMentionTargets } from "../web/lib/mentions.js";
import { tempDir } from "./helpers/tmp.mjs";

const MODELS = { claude: ["claude-haiku-5-5"], codex: ["gpt-5"], cursor: ["deepseek-v41-flash-1017-high"] };

function setup() {
  const home = tempDir({ after }, "ai-collab-pattern-edit-");
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

test("a project team can be copied into a second project and then appears as a mention target there", async (t) => {
  const home = tempDir(t, "ai-collab-pattern-copy-");
  const alpha = path.join(home, "alpha");
  const beta = path.join(home, "beta");
  mkdirSync(alpha);
  mkdirSync(beta);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([
    { root: alpha, project: "alpha", url: "http://127.0.0.1:9", peers: "claude,codex,cursor" },
    { root: beta, project: "beta", url: "http://127.0.0.1:9", peers: "claude,codex,cursor" },
  ]));
  const base = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), AI_COLLAB_PEER: "operator", AI_COLLAB_PEERS: "claude,codex,cursor", AI_COLLAB_URL: "http://127.0.0.1:9" };
  const envA = { ...base, AI_COLLAB_PROJECT: "alpha" };
  const envB = { ...base, AI_COLLAB_PROJECT: "beta" };
  const cfgA = loadConfig(envA);
  const cfgB = loadConfig(envB);
  const text = `digraph "crew" {
  graph [description="Do the work."];
  doer [agent="claude:claude-haiku-5-5", prompt="Do the work."];
  doer -> done [on="finished", kind="pair", required=true];
}
`;
  const source = path.join(alpha, ".ai-collab", "teams", "crew");
  mkdirSync(source, { recursive: true });
  const sourceFile = path.join(source, "team.dot");
  writeFileSync(sourceFile, text);
  assert.equal(listPatterns(cfgB, envB).crew.source, "other");
  assert.equal(listPatterns(cfgA, envA).crew.file, sourceFile);

  const copy = await copyPattern(cfgB, "crew", envB, MODELS);
  const dest = path.join(beta, ".ai-collab", "teams", "crew", "team.dot");
  assert.equal(copy.source, "project");
  assert.equal(copy.file, dest);
  assert.equal(readFileSync(dest, "utf8"), text);
  assert.equal(readFileSync(sourceFile, "utf8"), text);
  const listed = listPatterns(cfgB, envB).crew;
  assert.equal(listed.source, "project");
  assert.equal(listed.file, dest);
  assert.deepEqual(patternMentionTargets([listed]).map((option) => option.id), ["crew"]);
  assert.deepEqual(mentionedTeams("@crew ship it", ["crew"]), ["crew"]);
  await assert.rejects(copyPattern(cfgB, "crew", envB, MODELS), /already project/);
  assert.equal(readFileSync(sourceFile, "utf8"), text);
  assert.equal(listPatterns(cfgA, envA).crew.file, sourceFile);
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
