import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig, sessionLabel } from "../lib/config.mjs";

const HOOK = fileURLToPath(new URL("../scripts/ai-collab-hook.mjs", import.meta.url));
const run = (input, env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [HOOK, "--host", "claude"], { env, stdio: ["pipe", "pipe", "pipe"] });
  child.on("close", resolve);
  child.stdin.end(JSON.stringify(input));
});

test("a subagent's hook in another folder does not rewrite the parent's registry entry", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "ai-collab-state-"));
  const env = peerEnv(fake, { peer: "alice", stateDir });
  const cfg = { ...loadConfig(env), session: sessionLabel("s-root") };
  const file = path.join(cfg.stateDir, cfg.project, "registry", `alice#${cfg.session}.json`);
  const sub = mkdtempSync(path.join(os.tmpdir(), "agent-worktree-"));
  await run({ hook_event_name: "PostToolUse", session_id: "s-root", agent_id: "agent-1", tool_name: "Bash", cwd: sub }, env);
  assert.equal(existsSync(file), false, "the subagent registers nothing");
  await run({ hook_event_name: "UserPromptSubmit", session_id: "s-root", prompt: "hi" }, env);
  assert.equal(existsSync(file), true);
  assert.doesNotMatch(readFileSync(file, "utf8"), /agent-worktree-/);
});
