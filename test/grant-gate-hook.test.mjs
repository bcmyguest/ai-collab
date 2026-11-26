// The Claude PreToolUse hook allows the one call a stored signed approval names, once, and stays silent otherwise.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sessionLabel } from "../lib/config.mjs";
import { inputHash, loadSigner, signGrant, storeGrant } from "../lib/grants.mjs";

const HOOK = fileURLToPath(new URL("../scripts/ai-collab-hook.mjs", import.meta.url));
const SESSION_ID = "6f9c2a4e-0000-4000-8000-000000000001";
const INPUT = { command: "git apply /tmp/x.patch", description: "Apply the patch" };

function runHook(input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, "--grant-gate", "--host", "claude"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => resolve(JSON.parse(out.trim() || "null")));
    child.stdin.end(JSON.stringify(input));
  });
}

test("a stored grant lets the hook allow the exact call once", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "grant-gate-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stateDir = path.join(home, "state");
  const env = { HOME: home, AI_COLLAB_STATE_DIR: stateDir, PATH: path.dirname(process.execPath) };
  const session = sessionLabel(SESSION_ID);
  const token = signGrant(loadSigner(stateDir), { id: "0a1b2c3d4e5f", session, tool: "Bash", inputHash: inputHash("Bash", INPUT), by: "octocat" });
  assert.ok(storeGrant(stateDir, token));
  const call = { hook_event_name: "PreToolUse", session_id: SESSION_ID, tool_name: "Bash", tool_input: { ...INPUT, description: "reworded" } };

  const first = await runHook(call, env);
  assert.equal(first.hookSpecificOutput.permissionDecision, "allow");
  assert.deepEqual(await runHook(call, env), {});
  assert.deepEqual(await runHook({ ...call, tool_input: { command: "rm -rf /" } }, env), {});
});
