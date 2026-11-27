// Codex shells: its PreToolUse hook runs --activity only, so the managed shell-start gate must run there too.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MANAGED_ENV, SHELL_START_DENIED, shellHarnessStart } from "../lib/subagent-guard.ts";

const HOOK = fileURLToPath(new URL("../scripts/ai-collab-hook.mjs", import.meta.url));

function runHook(args, input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => resolve(JSON.parse(out || "null")));
    child.stdin.end(JSON.stringify(input));
  });
}

const shell = (command) => ({ hook_event_name: "PreToolUse", session_id: "s-codex", cwd: "/tmp", tool_name: "Bash", tool_input: { command } });

test("shellHarnessStart reads the Codex shell tool", () => {
  assert.equal(shellHarnessStart("codex", "pretooluse", shell("claude -p hi")), true);
  assert.equal(shellHarnessStart("codex", "pretooluse", shell("ls")), false);
});

test("a managed Codex session's activity hook denies a shell harness start; an operator session's does not", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "ai-collab-codex-gate-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: home, AI_COLLAB_URL: "http://127.0.0.1:9", AI_COLLAB_PROJECT: "demo", AI_COLLAB_STATE_DIR: join(home, "state"), AI_COLLAB_TIMEOUT_MS: "500", AI_COLLAB_ACTIVITY: "off" };
  const denied = await runHook(["--activity", "--host", "codex"], shell("nohup codex exec 'go'"), { ...env, [MANAGED_ENV]: "1" });
  assert.equal(denied.hookSpecificOutput?.permissionDecision, "deny");
  assert.equal(denied.hookSpecificOutput.permissionDecisionReason, SHELL_START_DENIED);
  const allowed = await runHook(["--activity", "--host", "codex"], shell("nohup codex exec 'go'"), env);
  assert.notEqual(allowed?.hookSpecificOutput?.permissionDecision, "deny");
});
