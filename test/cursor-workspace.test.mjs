import assert from "node:assert/strict";
import { test, after } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, sessionLabel } from "../lib/config.ts";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const HOOK = new URL("../scripts/ai-collab-hook.mjs", import.meta.url).pathname;

// A home folder that is itself a git repo, holding defaults.json and a workspace repo.
function home(url) {
  const dir = tempDir({ after }, "ai-collab-cursor-ws-");
  mkdirSync(path.join(dir, ".git"));
  mkdirSync(path.join(dir, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(dir, "token"), "tk_test");
  writeFileSync(path.join(dir, ".config", "ai-collab", "defaults.json"), JSON.stringify({ url, tokenFile: path.join(dir, "token"), peers: "cursor" }));
  const repo = path.join(dir, "code", "webshop");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  return { dir, repo };
}

test("a repo at the home folder never auto-joins", () => {
  const { dir, repo } = home("http://127.0.0.1:9");
  assert.equal(loadConfig({ HOME: dir }, { cwd: dir, host: "cursor" }).enabled, false);
  assert.equal(loadConfig({ HOME: dir }, { cwd: repo, host: "cursor" }).project, "webshop");
});

test("a Cursor hook run from home files its event under workspace_roots, not home", async () => {
  const fake = await startFakeNtfy();
  try {
    const { dir, repo } = home(fake.url);
    const input = { conversation_id: "f61871b9-8457-4401-972f-0a9c51f4184a", hook_event_name: "postToolUse", tool_name: "Shell",
      tool_input: { command: "ls" }, tool_output: "README.md", workspace_roots: [repo], cursor_version: "2026.11.19" };
    // Async spawn: the fake ntfy lives in this process and must keep serving while the hook runs.
    const child = spawn(process.execPath, [HOOK, "--host", "cursor"], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, AI_COLLAB_POLL_INTERVAL_MS: "0" } });
    child.stdin.end(JSON.stringify(input));
    const [code] = await once(child, "close");
    assert.equal(code, 0);
    const topics = fake.state.publishes.map((p) => p.topic);
    assert.ok(topics.includes("ai-collab-webshop--activity"), JSON.stringify(topics));
    assert.ok(!topics.some((t) => t.startsWith("ai-collab-" + path.basename(dir))), JSON.stringify(topics));
    const label = sessionLabel(input.conversation_id);
    assert.ok(existsSync(path.join(dir, ".local", "state", "ai-collab", "webshop", "sessions", "cursor", `${label}.json`)));
  } finally { await fake.close(); }
});
