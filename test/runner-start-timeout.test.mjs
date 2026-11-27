// A continuation or spawn whose start timed out (504) leaves no session behind, even when its claim lands late.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { wrapOpen } from "./helpers/fake-adapter-hooks.mjs";
import { loadConfig } from "../lib/config.mjs";
import { builderPaths } from "../lib/builder.ts";
import { listOwned } from "../lib/sessions/registry.ts";
import { openTasks } from "../lib/tasks.mjs";
import { openDurable } from "../runner/durable.mjs";
import { createRunner } from "../runner/runner.mjs";
import { createFakeAdapter } from "../runner/adapters/fake.mjs";

function setup(t, fake) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-start-timeout-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
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
  const adapter = createFakeAdapter({ harness: "codex" });
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
    adapter.open = async (...args) => { await slow.shut; return open(...args); };
    const late = runner.start(spawnInput("late child")).catch((error) => error);
    await until(() => cancelling, "the 504 cancel");
    slow.open();
    adapter.open = open;
    // The claim passes its abort check before the cancel lands.
    await until(() => listOwned(ctx.cfg).some((r) => r.spawn && r.status !== "ended"), "late claim");
    held.open();
    assert.equal((await late).status, 504);
    await until(() => listOwned(ctx.cfg).filter((r) => r.spawn).every((r) => r.status === "ended"), "late child ended");
    for (let i = 0; i < 4; i++) assert.equal((await runner.start(spawnInput(`child ${i}`))).status, "started");
  } finally {
    await runner.stop();
  }
});
