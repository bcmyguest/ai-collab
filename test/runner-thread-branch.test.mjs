import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { parseWireEnvelope } from "../lib/agui.ts";
import { readOwned } from "../lib/sessions/registry.ts";
import { createFakeAdapter } from "../runner/adapters/fake.ts";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { makeRunner as makeCtxRunner, setup as setupCtx, until } from "./helpers/runner-ctx.mjs";

const TO_CODEX = "ai-collab-demo--to--codex";

// The shared runner test home, removed after the test.
function setup(t, fake) {
  const ctx = setupCtx(fake);
  t.after(() => rmSync(ctx.home, { recursive: true, force: true }));
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  for (const args of [["init", "-q", "-b", "main"], ["commit", "-q", "--allow-empty", "-m", "init"], ["checkout", "-q", "-b", "thread/x"], ["commit", "-q", "--allow-empty", "-m", "thread work"]]) execFileSync("git", args, { cwd: ctx.root, env: gitEnv });
  return ctx;
}

const makeRunner = (ctx, adapter) => makeCtxRunner(ctx, [adapter]).runner;

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
