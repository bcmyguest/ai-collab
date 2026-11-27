// Spawns have no start gap, so two in the same second must still get distinct worktrees.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../lib/config.ts";
import { openDurable } from "../runner/durable.mjs";
import { createRunner } from "../runner/runner.mjs";
import { createFakeAdapter } from "../runner/adapters/fake.mjs";
import { fileEnd, tempDir } from "./helpers/tmp.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];

test("parallel worktree spawns in the same second each get their own worktree and branch", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = tempDir(fileEnd, "ai-collab-spawn-worktree-");
  const root = path.join(home, "demo");
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  execFileSync("git", ["init", "--quiet", "--template=", "-b", "main", root]);
  execFileSync("git", ["-C", root, ...ID, "commit", "--quiet", "--allow-empty", "-m", "init"]);
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), AI_COLLAB_STATE_DIR: path.join(home, "state"),
    AI_COLLAB_URL: fake.url, AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "runner", AI_COLLAB_PEERS: "codex,operator,runner", AI_COLLAB_TIMEOUT_MS: "2000",
  };
  const adapter = createFakeAdapter({ harness: "codex" });
  const runner = createRunner({ projects: [loadConfig(env, { cwd: root })], adapters: new Map([["codex", adapter]]), durable: openDurable(":memory:"), env, startGapMs: 0, watch: false, startTimeoutMs: 2000, now: () => 1_800_000_000_000 });
  await runner.boot();
  t.after(() => runner.stop());
  const parent = (await runner.start({ project: "demo", harness: "codex", prompt: "parent" })).session;
  const spawn = (prompt) => runner.start({ project: "demo", harness: "codex", prompt, place: "worktree", managed: true, parent, spawn: true, system: false });
  const children = await Promise.all(["first", "second", "third", "fourth"].map(spawn));
  assert.deepEqual(children.map((c) => c.status), ["started", "started", "started", "started"]);
  assert.equal(new Set(children.map((c) => c.cwd)).size, 4);
  const branches = execFileSync("git", ["-C", root, "branch", "--format=%(refname:short)"], { encoding: "utf8" }).split("\n").filter((n) => n.startsWith("ai-collab/"));
  assert.equal(branches.length, 4);
});
