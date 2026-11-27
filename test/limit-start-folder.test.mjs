import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { alertLimit, chooseLimit } from "../lib/limit-alert.ts";
import { recordSession } from "../lib/sessions.mjs";
import { startFolder, startSession } from "../lib/start.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const UUID = "5f0e3c2a-9b1d-4e7a-8c6b-2d1f0a9e8b7c";
const LIMIT = { window: "five_hour", windowName: "5-hour", resetsAt: null, wording: true, verified: true, source: "test" };

function projectHome(root) {
  const home = mkdtempSync(join(tmpdir(), "limit-folder-"));
  mkdirSync(join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo", url: "http://127.0.0.1:9", peers: "claude,codex" }]));
  return { HOME: home, PATH: process.env.PATH, AI_COLLAB_STATE_DIR: join(home, "state") };
}

test("startFolder runs in the root, in an existing folder inside the root, and refuses the rest", () => {
  const root = mkdtempSync(join(tmpdir(), "limit-root-"));
  const worktree = join(root, ".claude", "worktrees", "w1");
  mkdirSync(worktree, { recursive: true });
  assert.deepEqual(startFolder(root, ""), { cwd: root });
  assert.deepEqual(startFolder(root, worktree), { cwd: worktree });
  assert.match(startFolder(root, join(root, "gone")).error, /gone/);
  assert.match(startFolder(root, "/").error, /outside the project/);
});

test("startSession refuses a gone origin folder before it starts anything", async () => {
  const root = mkdtempSync(join(tmpdir(), "limit-root-"));
  const env = projectHome(root);
  let spawned = false;
  const run = () => { spawned = true; throw new Error("must not spawn"); };
  const out = await startSession({ project: "demo", stateDir: env.AI_COLLAB_STATE_DIR }, {
    harness: "codex", prompt: "continue", origin: join(root, ".claude", "worktrees", "gone"), env, run,
  });
  assert.equal(out.status, "failed");
  assert.match(out.detail, /gone/);
  assert.equal(spawned, false);
});

test("a replacement starts in the folder its session ran in", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "alice" });
  const cfg = loadConfig(env);
  const label = sessionLabel(UUID);
  const sessionCfg = { ...cfg, session: label };
  const cwd = "/tmp/limit-worktree-origin";
  await recordSession(sessionCfg, { id: UUID, cwd, harness: "claude", event: "start", name: "Fix the redirect", model: "claude-opus-5-5" });
  const sent = await alertLimit(sessionCfg, {
    harness: "claude", limit: LIMIT, listed: async () => ({ claude: [], codex: ["gpt-5"], cursor: [], opencode: [] }), available: () => ["codex"],
  });
  const calls = [];
  const start = async (_cfg, args) => { calls.push(args); return { status: "started", detail: "codex started", session: "codex#0123456789abcdef" }; };
  const out = await chooseLimit(cfg, { id: sent.id, label: "codex:gpt-5", start });
  assert.equal(out.status, "started");
  assert.equal(calls[0].origin, cwd);
  assert.equal(calls[0].place, "folder");
  assert.match(calls[0].prompt, /Session title: "Fix the redirect"/);
});
