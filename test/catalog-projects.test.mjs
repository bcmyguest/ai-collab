import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, after } from "node:test";
import { loadConfig } from "../lib/config.ts";
import { createPattern, deletePattern, saveTeamText } from "../lib/patterns.mjs";
import { createTeam, deleteTeam, setProjectClosed } from "../lib/teams.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const WRITER = fileURLToPath(new URL("./helpers/team-writer.mjs", import.meta.url));

function setup() {
  const home = tempDir({ after }, "ai-collab-catalog-projects-");
  const root = path.join(home, "repo");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  const projectsFile = path.join(home, ".config", "ai-collab", "projects.json");
  writeFileSync(projectsFile, JSON.stringify([{ root, project: "demo", url: "http://127.0.0.1:9", peers: "claude,codex" }]));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "operator", AI_COLLAB_PEERS: "claude,codex" };
  return { env, cfg: loadConfig(env), projectsFile, root };
}

const pair = () => ({
  name: "pair",
  roles: [
    { id: "lead", responsibility: "Scope it.", harness: "claude" },
    { id: "doer", responsibility: "Do it.", harness: "codex" },
  ],
  handoffs: [
    { from: "lead", to: "doer", on: "scope", required: false },
    { from: "doer", to: "done", on: "finished", required: true },
  ],
});

const runWriter = (env, prefix, count) => new Promise((resolve, reject) => {
  execFile(process.execPath, [WRITER, JSON.stringify(env), prefix, String(count)], { env: { ...process.env, CATALOG_TEAM_WRITER: "1" } }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${error.message}\n${stderr}`));
    else resolve(stdout);
  });
});

test("two processes writing projects.json at once keep every team", async () => {
  const { env, projectsFile } = setup();
  await Promise.all([runWriter(env, "alpha", 25), runWriter(env, "beta", 25)]);
  const [entry] = JSON.parse(readFileSync(projectsFile, "utf8"));
  const names = Object.keys(entry.teams).sort();
  assert.equal(names.length, 50);
  assert.ok(names.includes("alpha-0") && names.includes("beta-24"));
});

test("projects.json is pretty JSON with a trailing newline after a pattern save and delete", async () => {
  const { env, cfg, projectsFile } = setup();
  await createPattern(cfg, pair(), env, {});
  const saved = readFileSync(projectsFile, "utf8");
  assert.equal(saved, `${JSON.stringify([{
    root: JSON.parse(saved)[0].root,
    project: "demo",
    url: "http://127.0.0.1:9",
    peers: "claude,codex",
    patterns: {
      pair: {
        name: "pair",
        roles: [
          { id: "lead", responsibility: "Scope it.", harness: "claude" },
          { id: "doer", responsibility: "Do it.", harness: "codex" },
        ],
        handoffs: [
          { from: "lead", to: "doer", on: "scope", required: false },
          { from: "doer", to: "done", on: "finished", required: true },
        ],
      },
    },
  }], null, 2)}\n`);
  deletePattern(cfg, "pair", env);
  assert.deepEqual(JSON.parse(readFileSync(projectsFile, "utf8"))[0].patterns, {});
});

test("a team created, closed and deleted keeps the entry's key order and other fields", async () => {
  const { env, cfg, projectsFile, root } = setup();
  await createTeam(cfg, "crew", ["claude", "codex"], env);
  setProjectClosed(env, "demo", true);
  deleteTeam(cfg, "crew", env);
  assert.deepEqual(JSON.parse(readFileSync(projectsFile, "utf8")), [
    { root, project: "demo", url: "http://127.0.0.1:9", peers: "claude,codex", teams: {}, closed: true },
  ]);
});

test("saveTeamText writes the operator's text as given, with one trailing newline", async () => {
  const { env, cfg, root } = setup();
  const text = 'digraph "pair" {\n  lead [agent="claude", prompt="Scope it."];\n  lead -> done [on="scope", required=true];\n}';
  await saveTeamText(cfg, "pair", text, env, {});
  const file = path.join(root, ".ai-collab", "teams", "pair", "team.dot");
  assert.equal(readFileSync(file, "utf8"), `${text}\n`);
  await saveTeamText(cfg, "pair", `${text}\n`, env, {}, { create: false });
  assert.equal(readFileSync(file, "utf8"), `${text}\n`);
});
