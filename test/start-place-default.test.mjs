import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { START_PLACE, loadConfig, startPlaceSetting } from "../lib/config.ts";
import { openDurable } from "../runner/durable.mjs";
import { createRunner } from "../runner/runner.mjs";
import { createFakeAdapter } from "../runner/adapters/fake.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { fileEnd, tempDir } from "./helpers/tmp.mjs";

const PLACES = { places: ["folder", "worktree", "openshell"] };

function home(defaults) {
  const dir = tempDir(fileEnd, "ai-collab-place-");
  mkdirSync(path.join(dir, ".config", "ai-collab"), { recursive: true });
  if (defaults) writeFileSync(path.join(dir, ".config", "ai-collab", "defaults.json"), JSON.stringify(defaults));
  return dir;
}

test("the start place is openshell unless defaults.json startPlace names folder or worktree", () => {
  assert.equal(START_PLACE, "openshell");
  const at = (defaults) => startPlaceSetting({ XDG_CONFIG_HOME: path.join(home(defaults), ".config") });
  assert.equal(at(undefined), "openshell");
  assert.equal(at({ startPlace: "folder" }), "folder");
  assert.equal(at({ startPlace: "worktree" }), "worktree");
  assert.equal(at({ startPlace: "../tmp" }), "openshell");
});

async function startWith(t, { defaults, harness, capabilities = PLACES, openshell = true }) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const dir = home(defaults);
  const root = path.join(dir, "demo");
  mkdirSync(root);
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "init"]);
  writeFileSync(path.join(dir, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  const bin = path.join(dir, "fake-openshell");
  if (openshell) writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const env = {
    PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: path.join(dir, ".config"), AI_COLLAB_URL: fake.url,
    AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "runner", AI_COLLAB_PEERS: "codex,claude,cursor,operator,runner",
    AI_COLLAB_STATE_DIR: path.join(dir, "state"), AI_COLLAB_TIMEOUT_MS: "2000", AI_COLLAB_OPENSHELL_BIN: bin,
  };
  const adapter = createFakeAdapter({ harness, capabilities });
  const runner = createRunner({ projects: [loadConfig(env, { cwd: root })], adapters: new Map([[harness, adapter]]), durable: openDurable(":memory:"), env, startGapMs: 0, watch: false });
  await runner.boot();
  t.after(() => runner.stop());
  const started = await runner.start({ project: "demo", harness, prompt: "hi" });
  return { record: runner.get(started.session), root };
}

test("a runner start with no place goes to openshell with full access when the harness can run there", async (t) => {
  const { record } = await startWith(t, { harness: "cursor" });
  assert.deepEqual([record.place, record.permissionMode], ["openshell", "full-access"]);
});

test("a runner start with no place stays in the folder when startPlace is folder, openshell is missing, or the harness cannot", async (t) => {
  assert.equal((await startWith(t, { harness: "cursor", defaults: { startPlace: "folder" } })).record.place, "folder");
  assert.equal((await startWith(t, { harness: "cursor", openshell: false })).record.place, "folder");
  assert.equal((await startWith(t, { harness: "claude", capabilities: {} })).record.place, "folder");
  // Codex runs in OpenShell only as a tracked builder, so a plain start keeps the folder.
  assert.equal((await startWith(t, { harness: "codex" })).record.place, "folder");
});
