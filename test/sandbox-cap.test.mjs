// One cap over every OpenShell sandbox but run_code's: builders and runner sessions refuse over it, ticks skip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.ts";
import { openTasks } from "../lib/tasks.ts";
import { builder } from "../lib/builder.ts";
import { openDurable } from "../lib/durable.ts";
import { createRunner } from "../runner/runner.ts";
import { createFakeAdapter } from "../runner/adapters/fake.ts";
import { DEFAULT_MAX_SANDBOXES, countedSandboxes, maxSandboxes, sandboxCapRefusal } from "../lib/sandbox.ts";
import { sandboxRun } from "../runner/sandbox-run.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { fileEnd, tempDir } from "./helpers/tmp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPENSHELL = path.join(HERE, "helpers", "fake-openshell.mjs");
chmodSync(OPENSHELL, 0o755);
const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];

// A home with a git project "demo", a fake openshell whose list holds the given sandboxes, and defaults.json.
function lab(sandboxes, defaults) {
  const home = tempDir(fileEnd, "ai-collab-cap-");
  const root = path.join(home, "demo");
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  execFileSync("git", ["init", "--quiet", "--template=", "-b", "main", root]);
  execFileSync("git", ["-C", root, ...ID, "commit", "--quiet", "--allow-empty", "-m", "init"]);
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  if (defaults) writeFileSync(path.join(home, ".config", "ai-collab", "defaults.json"), JSON.stringify(defaults));
  const state = path.join(home, "openshell.json");
  writeFileSync(state, JSON.stringify({ sandboxes: sandboxes.map((name) => ({ name, phase: "Ready" })) }));
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, "data"),
    XDG_STATE_HOME: path.join(home, "state"), AI_COLLAB_STATE_DIR: path.join(home, "state"), AI_COLLAB_OPENSHELL_BIN: OPENSHELL, FAKE_OPENSHELL_STATE: state,
  };
  return { home, root, env };
}

const SIX = ["b-one-111111", "b-two-222222", "b-three-333333", "s-pm-444444", "ai-collab-other", "b-four-555555"];

test("the cap is 6 by default, read from maxSandboxes, and skips run_code's sandboxes", () => {
  assert.equal(DEFAULT_MAX_SANDBOXES, 6);
  assert.equal(maxSandboxes(lab([]).env), 6);
  assert.equal(maxSandboxes(lab([], { maxSandboxes: 9 }).env), 9);
  assert.equal(maxSandboxes(lab([], { maxSandboxes: 0 }).env), 6);
  assert.deepEqual(countedSandboxes(["ai-collab-code", "aic-ro-1a2b", "b-x-123456", "ai-collab-demo"]), ["b-x-123456", "ai-collab-demo"]);
});

test("the refusal names every counted sandbox; an existing sandbox the start reuses never counts as new", async () => {
  const { env } = lab([...SIX, "ai-collab-code", "aic-ro-9f9f"]);
  const refusal = await sandboxCapRefusal({ openshell: OPENSHELL, env, name: "ai-collab-demo" });
  assert.match(refusal, /6 OpenShell sandboxes are running \(b-one-111111, b-two-222222, b-three-333333, s-pm-444444, ai-collab-other, b-four-555555\); the cap is 6/);
  assert.equal(await sandboxCapRefusal({ openshell: OPENSHELL, env, name: "b-one-111111" }), "");
  assert.equal(await sandboxCapRefusal({ openshell: OPENSHELL, env: lab(SIX.slice(0, 5)).env, name: "new" }), "");
});

test("a runner openshell start over the cap is refused with the running sandboxes named", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const l = lab(SIX);
  const env = { ...l.env, AI_COLLAB_URL: fake.url, AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "runner", AI_COLLAB_PEERS: "cursor,operator,runner", AI_COLLAB_TIMEOUT_MS: "2000" };
  const adapter = createFakeAdapter({ harness: "cursor", capabilities: { places: ["folder", "worktree", "openshell"] } });
  const runner = createRunner({ projects: [loadConfig(env, { cwd: l.root })], adapters: new Map([["cursor", adapter]]), durable: openDurable(":memory:"), env, startGapMs: 0, watch: false });
  await runner.boot();
  t.after(() => runner.stop());
  await assert.rejects(runner.start({ project: "demo", harness: "cursor", prompt: "hi", place: "openshell" }), (error) => error.status === 409 && /6 OpenShell sandboxes are running \(b-one-111111/.test(error.message));
  const folder = await runner.start({ project: "demo", harness: "cursor", prompt: "hi", place: "folder" });
  assert.equal(folder.status, "started");
});

test("a builder start over the cap is refused before it makes a worktree", async () => {
  const l = lab(SIX);
  const env = { ...l.env, AI_COLLAB_BUILDER_WORKTREES: l.home };
  await openTasks("demo", env).add({ id: "capped", title: "Capped" });
  const brief = path.join(l.home, "brief.md");
  writeFileSync(brief, "Do the thing.\n");
  let err = "";
  const code = await builder(["start", "--task", "capped", "--harness", "cursor", "--brief", brief], {
    env, cfg: { project: "demo", stateDir: env.AI_COLLAB_STATE_DIR }, out: { write() {} }, err: { write: (s) => { err += s; } },
  });
  assert.equal(code, 1);
  assert.match(err, /6 OpenShell sandboxes are running \(b-one-111111.*the cap is 6/);
  assert.equal(execFileSync("git", ["-C", l.root, "worktree", "list"], { encoding: "utf8" }).trim().split("\n").length, 1);
});

test("a sandboxed tick over the cap skips with the reason logged and exits 0", async () => {
  const l = lab(SIX);
  const logs = [];
  const code = await sandboxRun({ name: "pm", cwd: l.root, command: ["cursor-agent", "-p", "x"] }, { env: l.env, log: (line) => logs.push(line) });
  assert.equal(code, 0);
  assert.match(logs.join("\n"), /skipped: 6 OpenShell sandboxes are running/);
});
