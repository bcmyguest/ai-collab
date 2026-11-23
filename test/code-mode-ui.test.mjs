// The UI start route takes the composer's codeMode and passes it to the Codex argv; a fake codex records it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadProjects } from "../lib/config.mjs";
import { createUi } from "../web/server/ui.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const base = "http://127.0.0.1:8795";
const ID = "66666666-2222-4333-8444-555555555555";
const FAKE = `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.FAKE_RECORD + "/codex-" + Date.now() + ".json", JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: "thread.started", thread_id: "${ID}" }));
`;

async function setup(t, defaults, runner) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-code-mode-ui-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const [bin, root, record, conf] = ["bin", "project", "record", ".config/ai-collab"].map((dir) => path.join(home, dir));
  for (const dir of [bin, root, record, conf]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(bin, "codex"), FAKE);
  chmodSync(path.join(bin, "codex"), 0o755);
  writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  writeFileSync(path.join(conf, "projects.json"), JSON.stringify([{ root, project: "demo", url: fake.url, peers: "codex,claude" }]));
  if (defaults) writeFileSync(path.join(conf, "defaults.json"), JSON.stringify(defaults));
  const env = { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH, HOME: home, PATH: bin + path.delimiter + process.env.PATH, FAKE_RECORD: record, CODEX_HOME: path.join(home, ".codex"),
    AI_COLLAB_STATE_DIR: path.join(home, "state"), AI_COLLAB_SESSION: "aaaaaaaaaaaaaaaa", AI_COLLAB_PEER: "codex", AI_COLLAB_UI_ORIGIN: "x" };
  const ui = createUi({ projects: loadProjects(env, { host: "operator" }), env, runner, models: async () => ({ codex: ["gpt-5"], claude: ["haiku"] }) });
  t.after(() => ui.close());
  const post = (body) => ui.handle(new Request(`${base}/api/start`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), "start");
  const argv = async () => {
    for (let i = 0; i < 200; i++) {
      const files = readdirSync(record);
      if (files.length) return JSON.parse(readFileSync(path.join(record, files[0]), "utf8"));
      await delay(20);
    }
    throw new Error("fake codex never ran");
  };
  return { post, argv };
}

test("a start's codeMode=false reaches the codex argv; a non-boolean codeMode is refused", async (t) => {
  const { post, argv } = await setup(t);
  assert.equal((await post({ project: "demo", harness: "codex", prompt: "go", codeMode: "yes" })).status, 400);
  const response = await post({ project: "demo", harness: "codex", prompt: "go", codeMode: false });
  assert.equal(response.status, 201);
  assert.deepEqual(await argv(), ["exec", "--json", "--dangerously-bypass-hook-trust", "-c", "features.code_mode=false", "go"]);
});

test("defaults.json codeMode=false turns code mode off for a start that names none", async (t) => {
  const { post, argv } = await setup(t, { codeMode: false });
  assert.equal((await post({ project: "demo", harness: "codex", prompt: "go" })).status, 201);
  assert.deepEqual(await argv(), ["exec", "--json", "--dangerously-bypass-hook-trust", "-c", "features.code_mode=false", "go"]);
});

test("the Claude composer routes code-mode Agent starts to the owned runner", async (t) => {
  const starts = [];
  const result = { status: "started", session: "claude#abc" };
  const { post } = await setup(t, { codeMode: false }, () => ({
    async start(input) {
      starts.push(input);
      return { status: 201, body: result };
    },
  }));
  const response = await post({ project: "demo", harness: "claude", model: "haiku", prompt: "go", codeMode: true });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), result);
  assert.deepEqual(starts, [{ project: "demo", harness: "claude", model: "haiku", prompt: "go", place: "folder", permissionMode: "supervised", codeMode: true, system: false }]);
});
