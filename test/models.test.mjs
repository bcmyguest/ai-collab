import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadProjects } from "../lib/config.mjs";
import { codexModels, cursorModels, parseCursorModels } from "../lib/models.mjs";
import { startCommand } from "../lib/start.mjs";
import { createUi } from "../web/server/ui.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const base = "http://127.0.0.1:8795";
const CURSOR_LIST = "Available models\n\nauto - Auto (default)\ngpt-5.3-codex - Codex 5.3\nclaude-opus-5-thinking-high - Claude Opus 5 1M Thinking\n--yolo - bad\n";
// Fake harnesses: cursor-agent prints a model list (and counts calls); claude records its argv and prints an id.
const FAKE_CURSOR = `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_RECORD + "/cursor-calls", "x");
if (process.argv.includes("--list-models")) process.stdout.write(${JSON.stringify(CURSOR_LIST)});
`;
const FAKE_CLAUDE = `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.FAKE_RECORD + "/claude.json", JSON.stringify(process.argv.slice(2)));
console.log("Started background session 11111111-2222-4333-8444-555555555555");
`;

function home() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai-collab-models-"));
  const bin = path.join(dir, "bin");
  const record = path.join(dir, "record");
  const codex = path.join(dir, ".codex");
  for (const d of [bin, record, codex, path.join(dir, "project"), path.join(dir, ".config", "ai-collab")]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(bin, "cursor-agent"), FAKE_CURSOR);
  writeFileSync(path.join(bin, "claude"), FAKE_CLAUDE);
  chmodSync(path.join(bin, "cursor-agent"), 0o755);
  chmodSync(path.join(bin, "claude"), 0o755);
  writeFileSync(path.join(codex, "models_cache.json"), JSON.stringify({ models: [
    { slug: "gpt-6.2-sol", visibility: "list" }, { slug: "secret-model", visibility: "hide" }, { slug: "-rm", visibility: "list" },
  ] }));
  writeFileSync(path.join(codex, "config.toml"), 'model = "gpt-6-luna"\n');
  const env = { HOME: dir, PATH: bin + path.delimiter + process.env.PATH, FAKE_RECORD: record, CODEX_HOME: codex, AI_COLLAB_STATE_DIR: path.join(dir, "state") };
  return { dir, env, record };
}

test("model flags in each harness's argv; malformed names give no command", () => {
  assert.deepEqual(startCommand("claude", "/r", "hi", { model: "opus" }), ["claude", ["--bg", "--model", "opus", "hi"]]);
  assert.deepEqual(startCommand("codex", "/r", "hi", { model: "gpt-6.2-sol" }), ["codex", ["exec", "--json", "--dangerously-bypass-hook-trust", "-m", "gpt-6.2-sol", "hi"]]);
  assert.deepEqual(startCommand("cursor", "/r", "hi", { model: "auto" }), ["cursor-agent", ["-p", "--trust", "--output-format", "stream-json", "--workspace", "/r", "--model", "auto", "hi"]]);
  for (const bad of ["--yolo", "a b", "", 7, "x;rm"]) assert.equal(startCommand("claude", "/r", "hi", { model: bad }), null, String(bad));
});

test("codex models come from its catalog cache and config; cursor's from --list-models, cached a day", async () => {
  const { env, record } = home();
  assert.deepEqual(codexModels(env), ["gpt-6-luna", "gpt-6.2-sol"]);
  assert.deepEqual(parseCursorModels(CURSOR_LIST), ["auto", "gpt-5.3-codex", "claude-opus-5-thinking-high"]);
  const now = Date.now();
  assert.deepEqual(await cursorModels(env.AI_COLLAB_STATE_DIR, env, { now }), ["auto", "gpt-5.3-codex", "claude-opus-5-thinking-high"]);
  await cursorModels(env.AI_COLLAB_STATE_DIR, env, { now: now + 1000 });
  assert.equal(readFileSync(path.join(record, "cursor-calls"), "utf8"), "x", "second read uses the cache");
  assert.deepEqual(await cursorModels(env.AI_COLLAB_STATE_DIR, env, { now: now + 2 * 86400_000, run: async () => "" }), ["auto", "gpt-5.3-codex", "claude-opus-5-thinking-high"], "stale cache when the command fails");
});

test("UI models action and a start with a listed model; an unlisted one is rejected before spawning", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const { dir, env, record } = home();
  writeFileSync(path.join(dir, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root: path.join(dir, "project"), project: "demo", url: fake.url, peers: "claude,codex,cursor" }]));
  const ui = createUi({ projects: loadProjects(env, { host: "operator" }), env });
  t.after(() => ui.close());
  const post = (action, body) => ui.handle(new Request(`${base}/api/${action}`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), action);
  const listed = await (await post("models", { project: "demo" })).json();
  assert.ok(listed.claude.includes("opus") && listed.codex.includes("gpt-6.2-sol") && listed.cursor.includes("auto"));
  const bad = await post("start", { project: "demo", harness: "claude", prompt: "hi", model: "--dangerously-skip-permissions" });
  assert.equal(bad.status, 400);
  assert.equal((await post("start", { project: "demo", harness: "claude", prompt: "hi", model: "gpt-6.2-sol" })).status, 400, "codex model for claude");
  const ok = await post("start", { project: "demo", harness: "claude", prompt: "hi", model: "sonnet" });
  assert.equal(ok.status, 201, JSON.stringify(await ok.clone().json()));
  for (let i = 0; i < 200 && !existsSync(path.join(record, "claude.json")); i++) await delay(20);
  assert.deepEqual(JSON.parse(readFileSync(path.join(record, "claude.json"), "utf8")), ["--bg", "--model", "sonnet", "hi"]);
});
