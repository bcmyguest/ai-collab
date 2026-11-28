// A continuation or spawn whose start timed out (504) leaves no session behind, even when its claim lands late.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FAKE_OPENSHELL, gitRepo } from "./helpers/runner-ctx.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { wrapOpen } from "./helpers/fake-adapter-hooks.mjs";
import { loadConfig } from "../lib/config.ts";
import { builderPaths } from "../lib/builder.ts";
import { listOwned, ownedFile } from "../lib/sessions/registry.ts";
import { openTasks } from "../lib/tasks.ts";
import { openDurable } from "../lib/durable.ts";
import { createRunner } from "../runner/runner.ts";
import { createFakeAdapter } from "../runner/adapters/fake.ts";
import { tempDir } from "./helpers/tmp.mjs";

function setup(t, fake) {
  const home = tempDir({ after }, "ai-collab-start-timeout-");
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
  const cfg = loadConfig(env, { cwd: root });
  return { home, root, env, cfg, db: path.join(home, "state", "runner.db") };
}

async function until(check, what, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const gate = () => { let open; const shut = new Promise((resolve) => { open = resolve; }); return { shut, open }; };

test("a continuation that times out with 504 is cancelled before it claims the task", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const ctx = setup(t, fake);
  const tasks = openTasks("demo", ctx.env);
  const paths = builderPaths("handoff", ctx.env);
  const git = (...args) => execFileSync("git", args, { cwd: ctx.root, stdio: "pipe" });
  git("init", "-b", "main");
  writeFileSync(path.join(ctx.root, "draft.txt"), "original\n");
  git("add", "draft.txt");
  git("-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "-m", "Initial");
  git("worktree", "add", "-b", "builder/handoff", paths.worktree);
  const owner = "codex#0123456789abcdef";
  await tasks.add({ id: "handoff", title: "Finish draft", owner, status: "blocked" });
  await tasks.update("handoff", { owner });
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.state, JSON.stringify({
    id: "handoff", project: "demo", task: "handoff", harness: "codex", address: owner, phase: "stopped", branch: "builder/handoff", worktree: paths.worktree,
  }));
  const claude = createFakeAdapter({ harness: "claude" });
  const slow = gate();
  const adapter = wrapOpen(claude, async (options, context, open) => { await slow.shut; return open(options, context); });
  const runner = createRunner({ projects: [ctx.cfg], adapters: new Map([["claude", adapter]]), durable: openDurable(ctx.db), env: ctx.env, startGapMs: 0, watch: false, startTimeoutMs: 1000 });
  await runner.boot();
  try {
    await assert.rejects(runner.continueBuilder({ project: "demo", taskId: "handoff", harness: "claude" }), { status: 504 });
    slow.open();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(tasks.get("handoff").owner, owner);
    assert.equal(tasks.get("handoff").status, "blocked");
    assert.equal(claude.calls.filter((c) => c.op === "send").length, 0);
    assert.deepEqual(listOwned(ctx.cfg).filter((r) => r.status !== "ended"), []);
    assert.equal(readFileSync(path.join(paths.worktree, "draft.txt"), "utf8"), "original\n");
  } finally {
    await runner.stop();
  }
});

test("a spawn whose claim lands after its 504 ends that child, so it does not count against the cap", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const ctx = setup(t, fake);
  const adapter = createFakeAdapter({ harness: "codex", capabilities: { places: ["folder", "worktree", "openshell"], openshellStarts: true } });
  const durable = openDurable(ctx.db);
  const cancel = durable.cancel.bind(durable);
  const held = gate();
  let cancelling = false;
  durable.cancel = async (id) => { cancelling = true; await held.shut; return cancel(id); };
  const runner = createRunner({ projects: [ctx.cfg], adapters: new Map([["codex", adapter]]), durable, env: ctx.env, startGapMs: 0, watch: false, startTimeoutMs: 1000 });
  await runner.boot();
  try {
    const parent = (await runner.start({ project: "demo", harness: "codex", prompt: "parent" })).session;
    const spawnInput = (prompt) => ({ project: "demo", harness: "codex", prompt, place: "folder", managed: true, parent, spawn: true, system: false });
    const open = adapter.open.bind(adapter);
    const slow = gate();
    // The late child's run ends only after the runner released it, as a loaded machine orders the two.
    adapter.open = async (options, context) => {
      await slow.shut;
      const late = (e) => (e.type === "RUN_FINISHED" ? setTimeout(() => context.emit(e), 100) : context.emit(e));
      return open(options, { ...context, emit: late });
    };
    const late = runner.start(spawnInput("late child, hang")).catch((error) => error);
    await until(() => cancelling, "the 504 cancel");
    slow.open();
    adapter.open = open;
    // The claim passes its abort check before the cancel lands.
    await until(() => listOwned(ctx.cfg).some((r) => r.spawn && r.status !== "ended"), "late claim");
    held.open();
    assert.equal((await late).status, 504);
    await until(() => listOwned(ctx.cfg).filter((r) => r.spawn).every((r) => r.status === "ended"), "late child ended");
    // It stays ended after its harness reports the run's end.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(listOwned(ctx.cfg).filter((r) => r.spawn).map((r) => r.status), ["ended"]);
    for (let i = 0; i < 4; i++) assert.equal((await runner.start(spawnInput(`child ${i}`))).status, "started");
  } finally {
    await runner.stop();
  }
});

test("a late child whose release fails is still marked ended and frees its cap slot", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const ctx = setup(t, fake);
  const adapter = createFakeAdapter({ harness: "codex", capabilities: { places: ["folder", "worktree", "openshell"], openshellStarts: true } });
  const durable = openDurable(ctx.db);
  const cancel = durable.cancel.bind(durable);
  const held = gate();
  let cancelling = false;
  durable.cancel = async (id) => { cancelling = true; await held.shut; return cancel(id); };
  const runner = createRunner({ projects: [ctx.cfg], adapters: new Map([["codex", adapter]]), durable, env: ctx.env, startGapMs: 0, watch: false, startTimeoutMs: 1000 });
  await runner.boot();
  try {
    const parent = (await runner.start({ project: "demo", harness: "codex", prompt: "parent" })).session;
    const spawnInput = (prompt) => ({ project: "demo", harness: "codex", prompt, place: "folder", managed: true, parent, spawn: true, system: false });
    const open = adapter.open.bind(adapter);
    const slow = gate();
    // Its run's end arrives after the release, which then drops it; only the release meets the write failure.
    adapter.open = async (options, context) => {
      await slow.shut;
      const late = (e) => (e.type === "RUN_FINISHED" ? setTimeout(() => context.emit(e), 300) : context.emit(e));
      return open(options, { ...context, emit: late });
    };
    const late = runner.start(spawnInput("late child approve: ls")).catch((error) => error);
    await until(() => cancelling, "the 504 cancel");
    slow.open();
    adapter.open = open;
    const record = await until(() => listOwned(ctx.cfg).find((r) => r.spawn && r.approvals?.length), "late child waiting on an approval");
    // Its owned record can no longer be written, so ending it throws part way.
    const file = ownedFile(ctx.cfg, record.label);
    rmSync(file);
    mkdirSync(file);
    held.open();
    assert.equal((await late).status, 504);
    await until(() => runner.get(record.address).status === "ended", "late child ended in memory");
    rmSync(file, { recursive: true });
    for (let i = 0; i < 4; i++) assert.equal((await runner.start(spawnInput(`child ${i}`))).status, "started");
  } finally {
    await runner.stop();
  }
});
