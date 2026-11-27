import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { loadConfig } from "../lib/config.ts";
import { parseDot } from "../lib/catalog/dot.ts";
import { createPattern, listPatterns, saveTeamText } from "../lib/patterns.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const MODELS = { claude: ["claude-haiku-5-5"], codex: ["gpt-5"], cursor: ["deepseek-v41-flash-1017-high"] };

function setup() {
  const home = tempDir({ after }, "ai-collab-team-files-");
  const root = path.join(home, "repo");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([
    { root, project: "demo", url: "http://127.0.0.1:9", peers: "claude,codex,cursor" },
  ]));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "operator", AI_COLLAB_PEERS: "claude,codex,cursor", AI_COLLAB_URL: "http://127.0.0.1:9" };
  return { env, cfg: loadConfig(env), root, globalDir: path.join(home, ".config", "ai-collab", "teams") };
}

const dot = (name, prompt = "Do it.", extra = "") => `digraph ${name} {
  worker [agent="claude:claude-haiku-5-5", count=2, skill="diagnose-failure", prompt="${prompt}"];
  checker [agent="codex", count=2, prompt="Check it."];
  worker -> checker [on="submit", kind="pair", required=true];
  checker -> done [on="pass", kind="fan-in", required=true${extra}];
}
`;

function writeTeam(dir, name, text) {
  mkdirSync(path.join(dir, name), { recursive: true });
  writeFileSync(path.join(dir, name, "team.dot"), text);
}

test("a project team.dot overrides a global team.dot of the same name", () => {
  const { env, cfg, root, globalDir } = setup();
  writeTeam(globalDir, "shared", dot("shared", "Global role."));
  writeTeam(path.join(root, ".ai-collab", "teams"), "shared", dot("shared", "Project role."));
  const entry = listPatterns(cfg, env).shared;
  assert.equal(entry.source, "project");
  assert.equal(entry.roles[0].responsibility, "Project role.");
  assert.equal(entry.roles[0].count, 2);
  assert.equal(entry.roles[0].skill, "diagnose-failure");
  assert.equal(entry.handoffs[1].kind, "fan-in");
});

test("a global team.dot that fails to parse is listed invalid with its line", () => {
  const { env, cfg, globalDir } = setup();
  writeTeam(globalDir, "broken", "digraph broken {\n  a [agent=\"gemini\"];\n}\n");
  const entry = listPatterns(cfg, env).broken;
  assert.equal(entry.source, "global");
  assert.match(entry.invalid, /line 2: agent harness must be one of/);
});

test("a team.dot whose digraph name differs from its folder is invalid", () => {
  const { env, cfg, globalDir } = setup();
  writeTeam(globalDir, "alpha", dot("beta"));
  assert.match(listPatterns(cfg, env).alpha.invalid, /must match the folder "alpha"/);
});

test("patterns.json converts to team.dot once and stays in place", () => {
  const { env, cfg, globalDir } = setup();
  mkdirSync(path.dirname(globalDir), { recursive: true });
  writeFileSync(path.join(path.dirname(globalDir), "patterns.json"), JSON.stringify({
    mine: {
      description: "Two roles.",
      roles: [{ id: "lead", responsibility: "Lead it.", harness: "claude", model: "claude-haiku-5-5" }, { id: "reviewer", responsibility: "Review it.", harness: "codex" }],
      handoffs: [{ from: "lead", to: "reviewer", on: "ready", required: true, cap: 2 }, { from: "reviewer", to: "done", on: "ok", required: true }],
    },
  }));
  listPatterns(cfg, env);
  const file = path.join(globalDir, "mine", "team.dot");
  assert.ok(existsSync(file));
  const team = parseDot(readFileSync(file, "utf8"));
  assert.equal(team.nodes[0].prompt, "Lead it.");
  assert.equal(team.edges[0].cap, 2);
  assert.equal(listPatterns(cfg, env).mine.source, "global");
  assert.ok(existsSync(path.join(path.dirname(globalDir), "patterns.json")), "patterns.json is kept");

  writeFileSync(file, dot("mine", "Edited by hand."));
  const again = listPatterns(cfg, env).mine;
  assert.equal(again.roles[0].responsibility, "Edited by hand.");
  assert.equal(readFileSync(file, "utf8"), dot("mine", "Edited by hand."), "a converted name is not written again");
});

test("saveTeamText writes canonical text and reads back as a project team", async () => {
  const { env, cfg, root } = setup();
  const saved = await saveTeamText(cfg, "pipe", dot("pipe"), env, MODELS);
  assert.equal(saved.source, "project");
  const file = path.join(root, ".ai-collab", "teams", "pipe", "team.dot");
  assert.equal(saved.file, file);
  assert.equal(readFileSync(file, "utf8"), dot("pipe"), "the file keeps the text as written");
  assert.equal(listPatterns(cfg, env).pipe.roles[1].harness, "codex");
});

test("saveTeamText refuses a name that differs from the digraph name", async () => {
  const { env, cfg } = setup();
  await assert.rejects(saveTeamText(cfg, "pipe", dot("other"), env, MODELS), /digraph name "other" must match "pipe"/);
});

test("a project team file blocks a JSON pattern of the same name", async () => {
  const { env, cfg } = setup();
  await saveTeamText(cfg, "pipe", dot("pipe"), env, MODELS);
  await assert.rejects(createPattern(cfg, { name: "pipe", roles: [{ id: "a", responsibility: "A.", harness: "claude" }], handoffs: [{ from: "a", to: "done", on: "x", required: true }] }, env, MODELS), /project team file/);
});

test("a busy projects.json lock makes a pattern write fail instead of racing", async () => {
  const { env, cfg } = setup();
  mkdirSync(path.join(env.HOME, ".config", "ai-collab", "projects.json.lock"));
  const pattern = { name: "solo", roles: [{ id: "a", responsibility: "A.", harness: "claude" }], handoffs: [{ from: "a", to: "done", on: "x", required: true }] };
  await assert.rejects(createPattern(cfg, pattern, env, MODELS), /projects.json is busy/);
});
