// Spawned Cursor children run in OpenShell with full access, never on the host (docs/spawn-agent-spec.md, answer 6).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.mjs";
import { listOwned } from "../lib/sessions/registry.ts";
import { openDurable } from "../runner/durable.mjs";
import { createRunner } from "../runner/runner.mjs";
import { createFakeAdapter } from "../runner/adapters/fake.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const OPENSHELL = fileURLToPath(new URL("./helpers/fake-openshell.mjs", import.meta.url));
chmodSync(OPENSHELL, 0o755);
const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];
const SIX = ["b-one-111111", "b-two-222222", "b-three-333333", "s-pm-444444", "ai-collab-other", "b-four-555555"];

// A git project "demo", a fake openshell listing `sandboxes`, a Codex parent and a Cursor adapter that can run in OpenShell.
async function lab(t, sandboxes, { openshell = OPENSHELL } = {}) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-spawn-openshell-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, "demo");
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  execFileSync("git", ["init", "--quiet", "--template=", "-b", "main", root]);
  execFileSync("git", ["-C", root, ...ID, "commit", "--quiet", "--allow-empty", "-m", "init"]);
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  const state = path.join(home, "openshell.json");
  const list = (names) => writeFileSync(state, JSON.stringify({ sandboxes: names.map((name) => ({ name, phase: "Ready" })) }));
  list(sandboxes);
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, "data"),
    XDG_STATE_HOME: path.join(home, "state"), AI_COLLAB_STATE_DIR: path.join(home, "state"), AI_COLLAB_OPENSHELL_BIN: openshell, FAKE_OPENSHELL_STATE: state,
    AI_COLLAB_URL: fake.url, AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "runner", AI_COLLAB_PEERS: "codex,cursor,operator,runner", AI_COLLAB_TIMEOUT_MS: "2000",
  };
  const cfg = loadConfig(env, { cwd: root });
  const codex = createFakeAdapter({ harness: "codex" });
  const cursor = createFakeAdapter({ harness: "cursor", capabilities: { places: ["folder", "worktree", "openshell"], permissionModes: ["supervised", "full-access"] } });
  const runner = createRunner({ projects: [cfg], adapters: new Map([["codex", codex], ["cursor", cursor]]), durable: openDurable(":memory:"), env, startGapMs: 0, watch: false, startTimeoutMs: 2000 });
  await runner.boot();
  t.after(() => runner.stop());
  const parent = (await runner.start({ project: "demo", harness: "codex", prompt: "parent" })).session;
  // The body spawn_agent sends (lib/spawn.ts): the host folder unless the caller asked for a worktree.
  const spawn = (prompt, place = "folder") => runner.start({ project: "demo", harness: "cursor", prompt, place, managed: true, parent, spawn: true, system: false });
  return { runner, cfg, cursor, spawn, list };
}

test("a spawned Cursor child runs in OpenShell with full access, whatever place the spawn names", async (t) => {
  const { cfg, cursor, spawn } = await lab(t, []);
  for (const place of ["folder", "worktree"]) assert.equal((await spawn(`child in ${place}`, place)).status, "started");
  const opens = cursor.calls.filter((c) => c.op === "open").map((c) => [c.options.place, c.options.permissionMode]);
  assert.deepEqual(opens, [["openshell", "full-access"], ["openshell", "full-access"]]);
  assert.deepEqual(listOwned(cfg).filter((r) => r.harness === "cursor").map((r) => [r.place, r.permissionMode]), [["openshell", "full-access"], ["openshell", "full-access"]]);
});

test("a spawned Cursor child at the sandbox cap is refused with the cap named and holds no child slot", async (t) => {
  const { cursor, spawn, list } = await lab(t, SIX);
  for (let i = 0; i < 5; i++) {
    await assert.rejects(spawn(`capped ${i}`), (error) => error.status === 409 && /6 OpenShell sandboxes are running.*the cap is 6/.test(error.message));
  }
  assert.equal(cursor.calls.filter((c) => c.op === "open").length, 0);
  // Every refused spawn released its slot: with room again, the parent's full 4 children start.
  list([]);
  for (let i = 0; i < 4; i++) assert.equal((await spawn(`child ${i}`)).status, "started");
});
