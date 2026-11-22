import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadProjects, sessionLabel } from "../lib/config.mjs";
import { startCommand, startRefusal } from "../lib/start.mjs";
import { createUi } from "../web/server/ui.mjs";
import { initialChoice } from "../web/lib/start-default.js";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const base = "http://127.0.0.1:8795";
const ID = "55555555-2222-4333-8444-555555555555";
const MODELS = {
  claude: ["claude-opus-5-5", "claude-sonnet-5"],
  codex: ["gpt-5.6-sol", "gpt-5-codex"],
  cursor: ["deepseek-v41-flash-1017-high", "composer-2.5"],
};
const SETTING = { harness: "cursor", model: "deepseek-v41-flash-1017-high" };
// Fake harness: records argv, then prints the id line its CLI prints first.
const FAKE = (harness) => `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_RECORD + "/${harness}.json", JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
const out = { claude: "Started background session ${ID}", codex: JSON.stringify({ type: "thread.started", thread_id: "${ID}" }),
  cursor: JSON.stringify({ type: "system", subtype: "init", session_id: "${ID}" }) };
console.log(out["${harness}"]);
`;

async function setup(t, { harnesses = ["claude", "codex", "cursor"] } = {}) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-new-session-"));
  const bin = path.join(home, "bin");
  const root = path.join(home, "project");
  const record = path.join(home, "record");
  for (const dir of [bin, root, record, path.join(home, ".config", "ai-collab")]) mkdirSync(dir, { recursive: true });
  const names = { claude: "claude", codex: "codex", cursor: "cursor-agent" };
  for (const harness of harnesses) {
    writeFileSync(path.join(bin, names[harness]), FAKE(harness));
    chmodSync(path.join(bin, names[harness]), 0o755);
  }
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo", url: fake.url, peers: "claude,codex,cursor" }]));
  const env = { HOME: home, PATH: bin + path.delimiter + process.env.PATH, FAKE_RECORD: record, CODEX_HOME: path.join(home, ".codex"),
    AI_COLLAB_STATE_DIR: path.join(home, "state"), AI_COLLAB_SESSION: "aaaaaaaaaaaaaaaa", AI_COLLAB_PEER: "claude", AI_COLLAB_UI_ORIGIN: "x" };
  const ui = createUi({ projects: loadProjects(env, { host: "operator" }), env, models: async () => MODELS });
  t.after(() => ui.close());
  const post = (body) => ui.handle(new Request(`${base}/api/start`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), "start");
  return { post, record };
}

async function recorded(record, harness) {
  for (let i = 0; i < 200; i++) {
    const file = path.join(record, harness + ".json");
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    await delay(20);
  }
  throw new Error("fake " + harness + " never ran");
}

test("the dialogue opens on the configured default when it can start here", () => {
  assert.deepEqual(initialChoice({ startable: ["claude", "cursor"], models: MODELS, setting: SETTING }), { harness: "cursor", model: "deepseek-v41-flash-1017-high" });
  // Model lists have not arrived: the configured model is kept rather than the pill reading its harness name.
  assert.deepEqual(initialChoice({ startable: ["cursor"], models: {}, setting: SETTING }), { harness: "cursor", model: "deepseek-v41-flash-1017-high" });
  // The configured harness is missing or delisted: the first startable harness with its first model.
  assert.deepEqual(initialChoice({ startable: ["claude", "codex"], models: MODELS, setting: SETTING }), { harness: "claude", model: "claude-opus-5-5" });
  assert.deepEqual(initialChoice({ startable: ["cursor", "claude"], models: { ...MODELS, cursor: ["other"] }, setting: SETTING }), { harness: "cursor", model: "other" });
  assert.deepEqual(initialChoice({ startable: [], models: MODELS, setting: SETTING }), { harness: "", model: "" });
  assert.deepEqual(initialChoice({ startable: ["codex"], models: MODELS }), { harness: "codex", model: "gpt-5.6-sol" });
});

test("the mode reaches the harness's argv, and an unsupported mode is refused before spawning", () => {
  assert.deepEqual(startCommand("claude", "/r", "hi", { mode: "plan" }), ["claude", ["--bg", "--permission-mode", "plan", "hi"]]);
  assert.deepEqual(startCommand("codex", "/r", "hi", { mode: "plan", model: "gpt-5.6-sol" }), ["codex", ["exec", "--json", "-s", "read-only", "-m", "gpt-5.6-sol", "hi"]]);
  assert.deepEqual(startCommand("cursor", "/r", "hi", { mode: "ask" }), ["cursor-agent", ["-p", "--trust", "--output-format", "stream-json", "--workspace", "/r", "--mode", "ask", "hi"]]);
  assert.deepEqual(startCommand("cursor", "/r", "hi", { mode: "plan", worktree: "w" }), ["cursor-agent", ["-p", "--trust", "--output-format", "stream-json", "--workspace", "/r", "--mode", "plan", "hi"]]);
  assert.deepEqual(startCommand("claude", "/r", "hi", { mode: "agent" }), startCommand("claude", "/r", "hi"), "agent adds no flag");
  assert.equal(startCommand("claude", "/r", "hi", { mode: "ask" }), null, "Claude has no ask mode");
  assert.equal(startCommand("bash", "/r", "hi", { mode: "plan" }), null);
  assert.equal(startRefusal("claude", "ask"), "Unknown claude mode");
  assert.equal(startRefusal("claude", "plan"), "");
  assert.equal(startRefusal("bash", "plan"), "Unknown harness");
});

test("the start action carries startMode to the harness and rejects a mode the harness lacks", async (t) => {
  const { post, record } = await setup(t);
  assert.equal((await post({ project: "demo", harness: "claude", prompt: "plan it", startMode: "ask" })).status, 400);
  assert.equal(existsSync(path.join(record, "claude.json")), false, "a refused mode spawns nothing");
  assert.equal((await post({ project: "demo", harness: "claude", prompt: "plan it", startMode: ["plan"] })).status, 400);

  const planned = await (await post({ project: "demo", harness: "claude", prompt: "plan it", startMode: "plan" })).json();
  assert.equal(planned.status, "started");
  assert.equal(planned.session, "claude#" + sessionLabel(ID));
  assert.deepEqual((await recorded(record, "claude")).argv, ["--bg", "--permission-mode", "plan", "plan it"]);
});

test("an unnamed mode starts the harness's normal editing mode, and the model pill's model is passed through", async (t) => {
  const { post, record } = await setup(t);
  const normal = await (await post({ project: "demo", harness: "cursor", prompt: "fix it", model: "composer-2.5" })).json();
  assert.equal(normal.status, "started");
  const run = await recorded(record, "cursor");
  assert.deepEqual(run.argv, ["-p", "--trust", "--output-format", "stream-json", "--workspace", run.cwd, "--model", "composer-2.5", "fix it"]);
  // An empty startMode is the same as none, so an older client keeps working.
  const second = await setup(t);
  await (await second.post({ project: "demo", harness: "codex", prompt: "ship it", startMode: "" })).json();
  assert.deepEqual((await recorded(second.record, "codex")).argv, ["exec", "--json", "-c", "features.code_mode=true", "ship it"]);
});
