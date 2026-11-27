// Runner starts honour a picked base, new branch or existing worktree, and refuse bad ones before a workflow starts.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../lib/config.ts";
import { openDurable } from "../lib/durable.ts";
import { createRunner } from "../runner/runner.ts";
import { createFakeAdapter } from "../runner/adapters/fake.ts";
import { tempDir } from "./helpers/tmp.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];

test("a runner worktree start uses the picked base and branch, or the picked existing worktree", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = tempDir(t, "ai-collab-runner-pick-");
  const root = path.join(home, "demo");
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", root, ...ID, ...args], { encoding: "utf8" });
  execFileSync("git", ["init", "--quiet", "--template=", "-b", "main", root]);
  git("commit", "--quiet", "--allow-empty", "-m", "one");
  const first = git("rev-parse", "HEAD").trim();
  git("branch", "older");
  git("commit", "--quiet", "--allow-empty", "-m", "two");
  const linked = path.join(home, "linked");
  git("worktree", "add", "--quiet", linked, "older");
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), AI_COLLAB_STATE_DIR: path.join(home, "state"),
    AI_COLLAB_URL: fake.url, AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "runner", AI_COLLAB_PEERS: "codex,operator,runner", AI_COLLAB_TIMEOUT_MS: "2000",
  };
  const adapter = createFakeAdapter({ harness: "codex" });
  const runner = createRunner({ projects: [loadConfig(env, { cwd: root })], adapters: new Map([["codex", adapter]]), durable: openDurable(":memory:"), env, startGapMs: 0, watch: false, startTimeoutMs: 2000, now: () => 1_800_000_000_000 });
  await runner.boot();
  t.after(() => runner.stop());
  const start = (body) => runner.start({ project: "demo", harness: "codex", prompt: "go", system: false, ...body });
  const made = await start({ place: "worktree", base: "older", branch: "feat/picked" });
  assert.equal(made.status, "started", JSON.stringify(made));
  assert.equal(git("rev-parse", "feat/picked").trim(), first);
  const opened = () => adapter.calls.filter((call) => call.op === "open").map((call) => call.options.cwd);
  assert.ok(opened()[0].startsWith(path.join(root, ".claude", "worktrees") + path.sep), opened()[0]);
  assert.equal((await start({ place: "worktree", worktreePath: linked })).status, "started");
  assert.equal(realpathSync(opened()[1]), realpathSync(linked));
  for (const body of [{ place: "folder", base: "main" }, { place: "worktree", base: "--all" }, { place: "worktree", worktreePath: root }, { place: "worktree", branch: "older" }]) {
    await assert.rejects(start(body), (error) => error.status === 400, JSON.stringify(body));
  }
});
