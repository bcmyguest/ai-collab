// Spawned OpenCode children run in OpenShell with full access, as Cursor's do; the cap reads OpenCode's own sandbox name.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.ts";
import { openDurable } from "../lib/durable.ts";
import { opencodeSandboxName } from "../lib/sandbox.ts";
import { createRunner } from "../runner/runner.ts";
import { createFakeAdapter } from "../runner/adapters/fake.ts";
import { fileEnd, tempDir } from "./helpers/tmp.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const OPENSHELL = fileURLToPath(new URL("./helpers/fake-openshell.mjs", import.meta.url));
chmodSync(OPENSHELL, 0o755);
const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];
const SIX = ["b-one-111111", "b-two-222222", "b-three-333333", "s-pm-444444", "ai-collab-other", "b-four-555555"];

// A git project "demo", a fake openshell listing `sandboxes`, a Codex parent and an OpenCode adapter that can run in OpenShell.
async function lab(t, sandboxes) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = tempDir(fileEnd, "ai-collab-spawn-opencode-");
  const root = path.join(home, "demo");
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  execFileSync("git", ["init", "--quiet", "--template=", "-b", "main", root]);
  execFileSync("git", ["-C", root, ...ID, "commit", "--quiet", "--allow-empty", "-m", "init"]);
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  const state = path.join(home, "openshell.json");
  writeFileSync(state, JSON.stringify({ sandboxes: sandboxes.map((name) => ({ name, phase: "Ready" })) }));
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, "data"),
    XDG_STATE_HOME: path.join(home, "state"), AI_COLLAB_STATE_DIR: path.join(home, "state"), AI_COLLAB_OPENSHELL_BIN: OPENSHELL, FAKE_OPENSHELL_STATE: state,
    AI_COLLAB_URL: fake.url, AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "runner", AI_COLLAB_PEERS: "codex,opencode,operator,runner", AI_COLLAB_TIMEOUT_MS: "2000",
  };
  const cfg = loadConfig(env, { cwd: root });
  const codex = createFakeAdapter({ harness: "codex" });
  const opencode = createFakeAdapter({ harness: "opencode", capabilities: { places: ["folder", "worktree", "openshell"], permissionModes: ["supervised", "accept-edits", "full-access"] } });
  const runner = createRunner({ projects: [cfg], adapters: new Map([["codex", codex], ["opencode", opencode]]), durable: openDurable(":memory:"), env, startGapMs: 0, watch: false, startTimeoutMs: 2000 });
  await runner.boot();
  t.after(() => runner.stop());
  const parent = (await runner.start({ project: "demo", harness: "codex", prompt: "parent" })).session;
  const spawn = (prompt, place = "folder") => runner.start({ project: "demo", harness: "opencode", prompt, place, managed: true, parent, spawn: true, system: false });
  return { opencode, spawn };
}

test("a spawned OpenCode child runs in OpenShell with full access, whatever place the spawn names", async (t) => {
  const { opencode, spawn } = await lab(t, []);
  for (const place of ["folder", "worktree"]) assert.equal((await spawn(`child in ${place}`, place)).status, "started");
  const opens = opencode.calls.filter((c) => c.op === "open").map((c) => [c.options.place, c.options.permissionMode]);
  assert.deepEqual(opens, [["openshell", "full-access"], ["openshell", "full-access"]]);
});

test("at the cap, a spawn into the project's existing OpenCode sandbox is a reuse, not refused", async (t) => {
  const { opencode, spawn } = await lab(t, [...SIX, opencodeSandboxName("demo")]);
  assert.equal((await spawn("reuse")).status, "started");
  assert.equal(opencode.calls.filter((c) => c.op === "open").length, 1);
});
