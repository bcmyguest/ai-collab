import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { loadConfig } from "../lib/config.ts";
import { copyPattern, createPattern, getPattern, removableNames, removePattern, savePattern } from "../lib/catalog/patterns.ts";
import { createTeam } from "../lib/catalog/roster.ts";
import { writeGlobalTeams } from "../lib/catalog/teams.ts";
import { tempDir } from "./helpers/tmp.mjs";

const MODELS = { claude: ["claude-haiku-5-5"], codex: ["gpt-5"], cursor: ["deepseek-v41-flash-1017-high"] };
const NAMES = ["constructor", "__proto__", "toString", "hasOwnProperty"];

function setup() {
  const home = tempDir({ after }, "ai-collab-pattern-names-");
  const root = path.join(home, "repo");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([
    { root, project: "demo", url: "http://127.0.0.1:9", peers: "claude,codex,cursor" },
  ]));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "operator", AI_COLLAB_PEERS: "claude,codex,cursor", AI_COLLAB_URL: "http://127.0.0.1:9" };
  return { env, cfg: loadConfig(env) };
}

const pair = (name) => ({
  name,
  roles: [{ id: "doer", responsibility: "Do it.", harness: "claude" }],
  handoffs: [{ from: "doer", to: "done", on: "finished", required: true }],
});

test("lookups by name find only own keys, so inherited names are unknown patterns", async () => {
  const { env, cfg } = setup();
  for (const name of NAMES) {
    assert.throws(() => getPattern(cfg, name, env), new RegExp(`unknown pattern "${name}"`));
    assert.throws(() => removePattern(cfg, name, env), new RegExp(`unknown pattern "${name}"`));
    await assert.rejects(copyPattern(cfg, name, env, MODELS), new RegExp(`unknown pattern "${name}"`));
    await assert.rejects(savePattern(cfg, pair("pair"), { replace: name }, env, MODELS), new RegExp(`unknown pattern "${name}"`));
  }
});

test("a rename check does not treat inherited names as taken", async () => {
  const { env, cfg } = setup();
  await createPattern(cfg, pair("pair"), env, MODELS);
  // Before the own-key lookup, all["constructor"] was Object's constructor and the rename was refused as taken.
  const renamed = await savePattern(cfg, pair("constructor"), { replace: "pair" }, env, MODELS);
  assert.equal(renamed.name, "constructor");
  assert.equal(getPattern(cfg, "constructor", env).source, "project");
});

test("removableNames holds the project's patterns and teams, not global teams", async () => {
  const { env, cfg } = setup();
  writeGlobalTeams(env, { crew: ["codex"] });
  await createPattern(cfg, pair("pair"), env, MODELS);
  await createTeam(cfg, "local", ["claude"], env, MODELS);
  const names = removableNames(cfg, env);
  assert.equal(names.has("pair"), true);
  assert.equal(names.has("local"), true);
  assert.equal(names.has("crew"), false);
  assert.equal(names.has("fix-and-review"), false);
});
