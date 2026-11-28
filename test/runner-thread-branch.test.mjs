import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseWireEnvelope } from "../lib/agui.ts";
import { loadConfig } from "../lib/config.ts";
import { readOwned } from "../lib/sessions/registry.ts";
import { openDurable } from "../lib/durable.ts";
import { createRunner } from "../runner/runner.ts";
import { createFakeAdapter } from "../runner/adapters/fake.ts";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { fileEnd, tempDir } from "./helpers/tmp.mjs";

const TO_CODEX = "ai-collab-demo--to--codex";

function setup(t, fake) {
  const home = tempDir(fileEnd, "ai-collab-runner-thread-branch-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, "demo");
  mkdirSync(root);
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  for (const args of [["init", "-q", "-b", "main"], ["commit", "-q", "--allow-empty", "-m", "init"], ["checkout", "-q", "-b", "thread/x"], ["commit", "-q", "--allow-empty", "-m", "thread work"]]) execFileSync("git", args, { cwd: root, env: gitEnv });
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), AI_COLLAB_URL: fake.url,
    AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "runner", AI_COLLAB_PEERS: "codex,claude,operator,runner",
    AI_COLLAB_STATE_DIR: path.join(home, "state"), AI_COLLAB_TIMEOUT_MS: "2000",
  };
  const cfg = loadConfig(env, { cwd: root });
  assert.equal(cfg.enabled, true, cfg.reason);
  return { root, env, cfg, db: path.join(home, "state", "runner.db") };
}

const makeRunner = (ctx, adapter) => createRunner({ projects: [ctx.cfg], adapters: new Map([[adapter.harness, adapter]]), durable: openDurable(ctx.db), env: ctx.env, startGapMs: 0, watch: false });

async function until(check, what, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const reports = (fake) => fake.state.publishes.filter((p) => p.topic === TO_CODEX).map((p) => parseWireEnvelope(p.message)).filter((e) => e?.body?.startsWith("[spawn_agent]"));
const spawnInput = (prompt, parent) => ({ project: "demo", harness: "codex", prompt, place: "folder", managed: true, parent, spawn: true, system: false });

test("a worktree child of a parent on a thread branch starts from it and records it as its merge target", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const ctx = setup(t, fake);
  const runner = makeRunner(ctx, createFakeAdapter({ harness: "codex" }));
  await runner.boot();
  t.after(() => runner.stop());
  const parent = (await runner.start({ project: "demo", harness: "codex", prompt: "parent", place: "folder" })).session;
  const { session } = await runner.start({ ...spawnInput("child", parent), place: "worktree" });
  const record = readOwned(ctx.cfg, session.split("#")[1]);
  assert.equal(record.spawn.mergeInto, "thread/x");
  const git = (...args) => execFileSync("git", args, { cwd: record.cwd, encoding: "utf8" }).trim();
  assert.equal(git("log", "-1", "--format=%s"), "thread work");
  await until(() => reports(fake).length, "report");
});
