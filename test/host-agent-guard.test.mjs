import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { recordSession } from "../lib/sessions.mjs";
import { openDurable } from "../runner/durable.mjs";
import { createRunner } from "../runner/runner.mjs";
import { createFakeAdapter } from "../runner/adapters/fake.mjs";
import { tickFn } from "../runner/schedules.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const cli = fileURLToPath(new URL("../scripts/ai-collab.mjs", import.meta.url));
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "ai-collab-guard-"));

// A fake cursor-agent that would print "ran" if it were ever started.
function fakeCursor(dir) {
  const file = path.join(dir, "cursor-agent");
  writeFileSync(file, "#!/bin/sh\necho ran\n", { mode: 0o700 });
  return file;
}

test("a schedule tick refuses a host agent with --force and names the way out; the allow variable runs it", async () => {
  const cwd = tmp();
  const command = [fakeCursor(cwd), "-p", "--force", "tick"];
  const tick = (env) => tickFn({ name: "beat", cwd, command, timeoutMs: 2000 }, { env, projects: [] })(new Date(0), new Date(0), { step: (_name, run) => run() });
  const refused = await tick({ AI_COLLAB_SCOPE: "off", PATH: process.env.PATH });
  assert.equal(refused.ok, false);
  assert.match(refused.tail, /refused to run cursor with --force on the host/);
  const allowed = await tick({ AI_COLLAB_SCOPE: "off", PATH: process.env.PATH, AI_COLLAB_ALLOW_HOST_AGENT: "1" });
  assert.equal(allowed.ok, true);
  assert.match(allowed.tail, /ran/);
});

test("job run refuses a host agent with approvals off before spawning it", async () => {
  const home = tmp();
  const id = "guard-job";
  const env = { HOME: home, PATH: process.env.PATH, AI_COLLAB_STATE_DIR: path.join(home, "state"), AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "codex", AI_COLLAB_SESSION: sessionLabel(id) };
  await recordSession(loadConfig(env, { cwd: home }), { id, cwd: home, harness: "codex", event: "Stop" });
  const run = spawnSync(process.execPath, [cli, "job", "run", "--", fakeCursor(home), "--force", "x"], { cwd: home, env, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /refused to run cursor with --force on the host/);
});

test("the runner refuses a full-access start or mode change outside openshell unless the allow variable is set", async () => {
  const fake = await startFakeNtfy();
  const home = tmp();
  const root = path.join(home, "demo");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), AI_COLLAB_URL: fake.url,
    AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "runner", AI_COLLAB_PEERS: "codex,claude,operator,runner",
    AI_COLLAB_STATE_DIR: path.join(home, "state"), AI_COLLAB_TIMEOUT_MS: "2000",
  };
  const cfg = loadConfig(env, { cwd: root });
  const make = (extra) => createRunner({ projects: [cfg], adapters: new Map([["claude", createFakeAdapter({ harness: "claude" })]]), durable: openDurable(":memory:"), env: { ...env, ...extra }, startGapMs: 0, watch: false });
  const runner = make({});
  await runner.boot();
  try {
    await assert.rejects(runner.start({ project: "demo", harness: "claude", prompt: "hi", permissionMode: "full-access" }), /full-access runs only in openshell/);
    const { session } = await runner.start({ project: "demo", harness: "claude", prompt: "hi", permissionMode: "auto" });
    await assert.rejects(runner.setMode(session, "full-access"), /full-access runs only in openshell/);
  } finally {
    await runner.stop();
  }
  const allowed = make({ AI_COLLAB_ALLOW_HOST_AGENT: "1" });
  await allowed.boot();
  try {
    const started = await allowed.start({ project: "demo", harness: "claude", prompt: "hi", permissionMode: "full-access" });
    assert.equal(started.status, "started");
  } finally {
    await allowed.stop();
    await fake.close();
  }
});
