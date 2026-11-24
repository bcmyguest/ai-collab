import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../lib/config.mjs";
import { checkTeamText, createPattern, listPatterns, saveTeamText, teamTemplates, teamTextOf } from "../lib/patterns.mjs";
import { renameTeam, sourceLine } from "../web/lib/team-editor.js";

const MODELS = { claude: ["claude-haiku-5-5"], codex: ["gpt-5"], cursor: ["deepseek-v41-flash-1017-high"] };

function setup() {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-team-editor-"));
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
  assert.deepEqual(templates.map((item) => item.name), ["fix-and-review", "review"]);
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
