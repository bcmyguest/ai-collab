// spec/tla/SpawnCap.tla: a spawn whose start timed out after its claim passed the abort check still registers its
// session; until its workflow stops it must keep its slot under SPAWN_MAX_CHILDREN, or a parent briefly runs five.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FAKE_OPENSHELL, gitRepo } from "./helpers/runner-ctx.mjs";
import { loadConfig } from "../lib/config.ts";
import { openDurable } from "../lib/durable.ts";
import { SPAWN_MAX_CHILDREN } from "../lib/spawn.ts";
import { adaptSqlite } from "../lib/workflows.ts";
import { createRunner } from "../runner/runner.ts";
import { createFakeAdapter } from "../runner/adapters/fake.ts";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { fileEnd, tempDir } from "./helpers/tmp.mjs";

function setup(t, fake) {
  const home = tempDir(fileEnd, "ai-collab-late-claim-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, "demo");
  mkdirSync(root);
  gitRepo(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), AI_COLLAB_URL: fake.url,
    AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "runner", AI_COLLAB_PEERS: "codex,claude,operator,runner",
    AI_COLLAB_STATE_DIR: path.join(home, "state"), AI_COLLAB_OPENSHELL_BIN: FAKE_OPENSHELL, AI_COLLAB_TIMEOUT_MS: "2000",
  };
  return { env, cfg: loadConfig(env, { cwd: root }), db: path.join(home, "state", "runner.db") };
}

// The sqlite engine with a hold after a session's claim step, where DBOS awaits its Postgres write of the step.
function gatedEngine(file, holdAfterClaim) {
  const base = adaptSqlite(openDurable(file));
  const gate = (wf, input) => {
    const gated = Object.create(wf);
    gated.step = async (name, body, opts) => { const out = await wf.step(name, body, opts); if (name === "claim") await holdAfterClaim(input); return out; };
    return gated;
  };
  return { ...base, register: (name, fn) => base.register(name, name === "session" ? (wf, input) => fn(gate(wf, input), input) : fn) };
}

async function until(check, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("a timed-out spawn whose claim already passed keeps its slot until its workflow stops", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const ctx = setup(t, fake);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let reached;
  const atHold = new Promise((resolve) => { reached = resolve; });
  const durable = gatedEngine(ctx.db, async (input) => { if (input.prompt.includes("late child")) { reached(); await held; } });
  const adapter = createFakeAdapter({ harness: "codex", capabilities: { places: ["folder", "worktree", "openshell"], openshellStarts: true } });
  const runner = createRunner({ projects: [ctx.cfg], adapters: new Map([[adapter.harness, adapter]]), durable, env: ctx.env, startGapMs: 0, watch: false, startTimeoutMs: 1000 });
  await runner.boot();
  t.after(() => { release(); return runner.stop(); });
  const parent = (await runner.start({ project: "demo", harness: "codex", prompt: "parent", place: "folder" })).session;
  const spawn = (prompt) => runner.start({ project: "demo", harness: "codex", prompt, place: "folder", managed: true, parent, spawn: true, system: false });
  // Every session but the parent is its child here; the session view carries no parent field.
  const liveChildren = () => runner.list().filter((r) => r.session !== parent && r.status !== "ended").length;

  const late = spawn("late child");
  await atHold;
  await assert.rejects(late, { status: 504 });
  // SpawnCap.tla Timeout then Admit: the late child still counts, so only SPAWN_MAX_CHILDREN - 1 more start.
  const outcomes = [];
  for (let i = 0; i < SPAWN_MAX_CHILDREN; i++) outcomes.push(await spawn(`child ${i}`).then((r) => r.status, (e) => e.status));
  assert.deepEqual(outcomes, [...Array(SPAWN_MAX_CHILDREN - 1).fill("started"), 429]);
  // Register, then ReleaseCancelled: the late session appears and ends, and its slot frees; the cap holds throughout.
  release();
  let peak = 0;
  await until(async () => {
    peak = Math.max(peak, liveChildren());
    return (await spawn("after").then((r) => r.status, (e) => e.status)) === "started";
  }, "a free slot");
  assert.ok(peak <= SPAWN_MAX_CHILDREN, `peak ${peak} live children`);
});
