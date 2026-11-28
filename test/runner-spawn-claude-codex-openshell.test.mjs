// Spawned Claude and Codex children run in OpenShell with full access, never on the host (docs/spawn-agent-spec.md, answer 6).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.ts";
import { listOwned } from "../lib/sessions/registry.ts";
import { openDurable } from "../lib/durable.ts";
import { createRunner } from "../runner/runner.ts";
import { createFakeAdapter } from "../runner/adapters/fake.ts";
import { fileEnd, tempDir } from "./helpers/tmp.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const OPENSHELL = fileURLToPath(new URL("./helpers/fake-openshell.mjs", import.meta.url));
chmodSync(OPENSHELL, 0o755);
const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];
const PLACES = ["folder", "worktree", "openshell"];

// A git project "demo", a fake openshell, a parent of the other harness on the host folder, and Claude and Codex adapters that can run in OpenShell.
async function lab(t, child, { openshell = OPENSHELL } = {}) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = tempDir(fileEnd, "ai-collab-spawn-cc-openshell-");
  const root = path.join(home, "demo");
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  execFileSync("git", ["init", "--quiet", "--template=", "-b", "main", root]);
  execFileSync("git", ["-C", root, ...ID, "commit", "--quiet", "--allow-empty", "-m", "init"]);
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, "data"),
    XDG_STATE_HOME: path.join(home, "state"), AI_COLLAB_STATE_DIR: path.join(home, "state"), AI_COLLAB_OPENSHELL_BIN: openshell, FAKE_OPENSHELL_STATE: path.join(home, "openshell.json"),
    AI_COLLAB_URL: fake.url, AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "runner", AI_COLLAB_PEERS: "codex,claude,operator,runner", AI_COLLAB_TIMEOUT_MS: "2000",
  };
  const cfg = loadConfig(env, { cwd: root });
  const adapters = {
    codex: createFakeAdapter({ harness: "codex", capabilities: { places: PLACES, openshellStarts: true } }),
    claude: createFakeAdapter({ harness: "claude", capabilities: { places: PLACES } }),
  };
  const runner = createRunner({ projects: [cfg], adapters: new Map(Object.entries(adapters)), durable: openDurable(":memory:"), env, startGapMs: 0, watch: false, startTimeoutMs: 2000 });
  await runner.boot();
  t.after(() => runner.stop());
  const parent = (await runner.start({ project: "demo", harness: child === "codex" ? "claude" : "codex", prompt: "parent", place: "folder" })).session;
  const spawn = (harness, prompt, place = "folder") => runner.start({ project: "demo", harness, prompt, place, managed: true, parent, spawn: true, system: false });
  return { cfg, adapters, spawn };
}

for (const harness of ["claude", "codex"]) {
  test(`a spawned ${harness} child runs in OpenShell with full access, whatever place the spawn names`, async (t) => {
    const { cfg, adapters, spawn } = await lab(t, harness);
    for (const place of ["folder", "worktree"]) assert.equal((await spawn(harness, `child in ${place}`, place)).status, "started");
    const opens = adapters[harness].calls.filter((c) => c.op === "open").map((c) => [c.options.place, c.options.permissionMode, c.options.managed]);
    assert.deepEqual(opens, [["openshell", "full-access", true], ["openshell", "full-access", true]]);
    const records = listOwned(cfg).filter((r) => r.harness === harness).map((r) => [r.place, r.permissionMode]);
    assert.deepEqual(records, [["openshell", "full-access"], ["openshell", "full-access"]]);
  });

  test(`without OpenShell a spawned ${harness} child is refused with an error naming it, not started on the host`, async (t) => {
    const { adapters, spawn } = await lab(t, harness, { openshell: path.join(os.tmpdir(), "no-such-openshell-bin") });
    await assert.rejects(spawn(harness, "no sandbox"), (error) => error.status === 409 && /OpenShell/.test(error.message) && /not installed/.test(error.message));
    assert.equal(adapters[harness].calls.filter((c) => c.op === "open").length, 0);
  });
}
