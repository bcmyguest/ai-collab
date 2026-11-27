import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, after } from "node:test";
import { loadConfig } from "../lib/config.ts";
import { checkTeamText, createPattern, listPatterns, saveTeamText, teamTemplates, teamTextOf } from "../lib/patterns.mjs";
import { projectTeamsDir, teamFilePath } from "../lib/catalog/team-files.ts";
import { renameTeam, sourceLine } from "../web/lib/team-editor.js";
import { tempDir } from "./helpers/tmp.mjs";

const MODELS = { claude: ["claude-haiku-5-5"], codex: ["gpt-5"], cursor: ["deepseek-v41-flash-1017-high"] };
const execFileAsync = promisify(execFile);

function setup() {
  const home = tempDir({ after }, "ai-collab-team-editor-");
  const root = path.join(home, "repo");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([
    { root, project: "demo", url: "http://127.0.0.1:9", peers: "claude,codex,cursor" },
  ]));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "operator", AI_COLLAB_PEERS: "claude,codex,cursor", AI_COLLAB_URL: "http://127.0.0.1:9" };
  return { env, cfg: loadConfig(env), root };
}

const TEXT = `digraph pipe {
  a [agent="claude", prompt="A."];
  b [agent="codex", prompt="B."];
  a -> b [on="go"];
  b -> done [on="finish"];
}
`;

test("checkTeamText returns the pattern, or the error with its line, without writing", () => {
  const { cfg } = setup();
  const good = checkTeamText(cfg, "pipe", TEXT);
  assert.equal(good.ok, true);
  assert.equal(good.pattern.roles[1].harness, "codex");
  const bad = checkTeamText(cfg, "pipe", TEXT.replace('agent="codex"', 'agent="gemini"'));
  assert.equal(bad.ok, false);
  assert.equal(bad.line, 3);
  assert.match(bad.error, /^line 3: agent harness must be one of/);
  assert.equal(checkTeamText(cfg, "other", TEXT).ok, false, "a name that differs from the digraph is refused");
});

test("saveTeamText and listPatterns agree on a team the editor saved", async () => {
  const { env, cfg, root } = setup();
  const saved = await saveTeamText(cfg, "pipe", TEXT, env, MODELS);
  assert.equal(saved.source, "project");
  assert.equal(listPatterns(cfg, env).pipe.source, "project");
  assert.equal(teamTextOf(listPatterns(cfg, env).pipe), readFileSync(path.join(root, ".ai-collab", "teams", "pipe", "team.dot"), "utf8"));
});

test("a project pattern's editor text is its canonical DOT; a global or built-in one is read-only text", () => {
  const { cfg, env } = setup();
  const built = listPatterns(cfg, env)["fix-and-review"];
  assert.equal(built.source, "built-in");
  assert.match(teamTextOf(built), /^digraph "fix-and-review" \{/m);
  assert.equal(built.editable, undefined);
});

test("a team.dot symlink to a file outside the repo is not listed and its text is not read", () => {
  const { env, cfg, root } = setup();
  const secret = path.join(path.dirname(root), "secret-key.txt");
  writeFileSync(secret, "PRIVATE KEY MATERIAL\n");
  mkdirSync(path.join(root, ".ai-collab", "teams", "linked"), { recursive: true });
  symlinkSync(secret, path.join(root, ".ai-collab", "teams", "linked", "team.dot"));
  assert.equal(listPatterns(cfg, env).linked, undefined);
  assert.equal(teamTextOf({ name: "linked", file: path.join(root, ".ai-collab", "teams", "linked", "team.dot"), source: "project" }), "");
});

test("the shipped templates list fix-and-review with its DOT text", () => {
  const templates = teamTemplates();
  assert.deepEqual(templates.map((item) => item.name), ["fix-and-review", "product", "review"]);
  assert.match(templates[0].text, /digraph "fix-and-review"/);
});

test("renameTeam rewrites the digraph name and keeps the rest of the text", () => {
  assert.equal(renameTeam('// note\ndigraph "old" {\n  a [agent="claude"];\n}', "new-one"), '// note\ndigraph "new-one" {\n  a [agent="claude"];\n}');
  assert.equal(renameTeam("digraph plain {}", "x"), 'digraph "x" {}');
  assert.equal(renameTeam("digraph keep {}", ""), "digraph keep {}");
});

test("sourceLine returns the line a parse error names", () => {
  assert.equal(sourceLine("a\nb\nc", 2), "b");
  assert.equal(sourceLine("a\nb", 0), "");
  assert.equal(sourceLine("a", 9), "");
});

test("a new team with an existing name is refused and the file is untouched", async () => {
  const { env, cfg, root } = setup();
  await saveTeamText(cfg, "pipe", TEXT, env, MODELS, { create: true });
  const file = path.join(root, ".ai-collab", "teams", "pipe", "team.dot");
  const before = readFileSync(file, "utf8");
  await assert.rejects(saveTeamText(cfg, "pipe", TEXT.replace('"A."', '"Changed."'), env, MODELS, { create: true }), /already exists/);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("an edit save keeps the operator's comments and removes the JSON pattern it replaces", async () => {
  const { env, cfg, root } = setup();
  await createPattern(cfg, { name: "pipe", roles: [{ id: "a", responsibility: "A.", harness: "claude" }, { id: "b", responsibility: "B.", harness: "codex" }], handoffs: [{ from: "a", to: "b", on: "go", required: true }, { from: "b", to: "done", on: "finish", required: true }] }, env, MODELS);
  const text = `// hand-written note\n${TEXT}`;
  await saveTeamText(cfg, "pipe", text, env, MODELS);
  assert.equal(readFileSync(path.join(root, ".ai-collab", "teams", "pipe", "team.dot"), "utf8"), text);
  const projects = JSON.parse(readFileSync(path.join(env.HOME, ".config", "ai-collab", "projects.json"), "utf8"));
  assert.equal(projects[0].patterns?.pipe, undefined, "the JSON entry is gone");
});

test("a team save whose team file stays locked fails busy within a second and releases projects.json", async () => {
  const { env, cfg, root } = setup();
  const file = teamFilePath(projectTeamsDir(root), "pipe");
  mkdirSync(`${file}.lock`, { recursive: true });
  const started = Date.now();
  await assert.rejects(saveTeamText(cfg, "pipe", TEXT, env, MODELS), /busy/);
  assert.ok(Date.now() - started < 1000, `waited ${Date.now() - started} ms`);
  assert.equal(existsSync(path.join(env.XDG_CONFIG_HOME, "ai-collab", "projects.json.lock")), false, "the projects.json lock is released");
  rmSync(`${file}.lock`, { recursive: true, force: true });
});

test("two concurrent creates of one team name: one saves, the other says it exists", async () => {
  const { env } = setup();
  const base = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "lib")).href;
  const child = (name, startAt) => execFileAsync(process.execPath, ["--input-type=module", "-e", `
    const { loadConfig } = await import(${JSON.stringify(`${base}/config.ts`)});
    const { saveTeamText } = await import(${JSON.stringify(`${base}/patterns.mjs`)});
    const env = ${JSON.stringify(env)};
    const text = ${JSON.stringify(TEXT.replaceAll("pipe", name))};
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, ${startAt} - Date.now())));
    try { await saveTeamText(loadConfig(env), ${JSON.stringify(name)}, text, env, ${JSON.stringify(MODELS)}, { create: true }); console.log("saved"); }
    catch (error) { console.log(error.message); }
  `]).then((out) => out.stdout.trim());
  for (let trial = 0; trial < 12; trial += 1) {
    const name = `race${trial}`;
    const startAt = Date.now() + 300;
    const [a, b] = await Promise.all([child(name, startAt), child(name, startAt)]);
    assert.equal([a, b].filter((line) => line === "saved").length, 1, `trial ${trial}: ${a} | ${b}`);
    assert.match([a, b].find((line) => line !== "saved"), /already exists/);
  }
});
