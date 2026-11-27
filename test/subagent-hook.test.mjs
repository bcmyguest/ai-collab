import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, sessionLabel } from "../lib/config.ts";
import { writeOwned } from "../lib/sessions/registry.ts";
import { MANAGED_ENV, SHELL_START_DENIED, SUBAGENT_DENIED } from "../lib/subagent-guard.ts";
import { job } from "../lib/job.ts";
import { tempDir } from "./helpers/tmp.mjs";

const HOOK = fileURLToPath(new URL("../scripts/ai-collab-hook.mjs", import.meta.url));

function runHook(args, input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, json: JSON.parse(out || "null") }));
    child.stdin.end(JSON.stringify(input));
  });
}

function setup(t) {
  const home = tempDir({ after }, "ai-collab-subagent-hook-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH, HOME: home, AI_COLLAB_URL: "http://127.0.0.1:9", AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "cursor",
    AI_COLLAB_STATE_DIR: join(home, "state"), AI_COLLAB_TIMEOUT_MS: "500", AI_COLLAB_ACTIVITY: "off",
  };
  return { home, env };
}

const agentCall = { hook_event_name: "PreToolUse", session_id: "s-1", cwd: "/tmp", tool_name: "Agent", tool_input: { prompt: "look around" } };
const claudeDeny = (reason) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

test("claude read gate denies the Agent tool in a managed session", async (t) => {
  const { env } = setup(t);
  const r = await runHook(["--read-gate", "--host", "claude"], agentCall, { ...env, [MANAGED_ENV]: "1" });
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, claudeDeny(SUBAGENT_DENIED));
});

test("claude read gate allows the Agent tool in an operator session", async (t) => {
  const { env } = setup(t);
  const r = await runHook(["--read-gate", "--host", "claude"], agentCall, env);
  assert.deepEqual(r.json, {});
});

test("claude read gate denies a shell harness start in a managed session only", async (t) => {
  const { env } = setup(t);
  const call = { hook_event_name: "PreToolUse", session_id: "s-1", cwd: "/tmp", tool_name: "Bash", tool_input: { command: "codex exec 'do it'" } };
  assert.deepEqual((await runHook(["--read-gate", "--host", "claude"], call, { ...env, [MANAGED_ENV]: "1" })).json, claudeDeny(SHELL_START_DENIED));
  assert.deepEqual((await runHook(["--read-gate", "--host", "claude"], call, env)).json, {});
  const other = { ...call, tool_input: { command: "npm test" } };
  assert.deepEqual((await runHook(["--read-gate", "--host", "claude"], other, { ...env, [MANAGED_ENV]: "1" })).json, {});
});

test("cursor subagentStart is denied by a live managed owned record", async (t) => {
  const { home, env } = setup(t);
  const conversation = "c0ffee00-1111-2222-3333-444455556666";
  const label = sessionLabel(conversation);
  const cfg = loadConfig({ ...env, AI_COLLAB_SESSION: label }, { cwd: home, host: "cursor", session: label });
  const input = { hook_event_name: "subagentStart", conversation_id: conversation, workspace_roots: [home], cursor_version: "2026.11.22" };
  const base = { v: 1, label, address: `cursor#${label}`, harness: "cursor", project: "demo", cwd: home, approvals: [] };

  writeOwned(cfg, { ...base, managed: true, status: "idle" });
  const denied = await runHook(["--read-gate", "--host", "cursor"], input, env);
  assert.deepEqual(denied.json, { permission: "deny", user_message: SUBAGENT_DENIED, agent_message: SUBAGENT_DENIED });

  writeOwned(cfg, { ...base, status: "idle" });
  assert.deepEqual((await runHook(["--read-gate", "--host", "cursor"], input, env)).json, {});

  writeOwned(cfg, { ...base, managed: true, status: "ended" });
  assert.deepEqual((await runHook(["--read-gate", "--host", "cursor"], input, env)).json, {});
});

test("job run refuses a harness command in a managed session", async () => {
  let err = "";
  const cfg = { enabled: true, peer: "claude", session: "0123456789abcdef", stateDir: tmpdir(), project: "demo" };
  const code = await job(["run", "--", "codex", "exec", "hi"], {
    cfg, env: { [MANAGED_ENV]: "1" }, out: { write() {} }, err: { write: (s) => { err += s; } }, registered: () => true,
  });
  assert.equal(code, 1);
  assert.match(err, /spawn_agent/);
});
