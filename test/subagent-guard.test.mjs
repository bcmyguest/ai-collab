import test from "node:test";
import assert from "node:assert/strict";
import { managedShellStartRefusal, SHELL_START_DENIED } from "../lib/agent-guard.mjs";
import {
  MANAGED_ENV, SUBAGENT_DENIED, managedEnv, nativeSubagentCall, noSubagentArgs, noSubagentEnv, shellHarnessStart, subagentDenial,
} from "../lib/subagent-guard.ts";

test("noSubagentArgs: Claude settings deny, Codex -c pairs, nothing for opencode and cursor", () => {
  assert.deepEqual(noSubagentArgs("claude"), ["--settings", '{"permissions":{"deny":["Agent","Task"]}}']);
  assert.deepEqual(noSubagentArgs("codex"), ["-c", "agents.enabled=false", "-c", "features.multi_agent_v2=false"]);
  assert.deepEqual(noSubagentArgs("opencode"), []);
  assert.deepEqual(noSubagentArgs("cursor"), []);
});

test("noSubagentEnv: marks the start managed and merges the OpenCode deny into existing config", () => {
  assert.deepEqual(noSubagentEnv("claude", {}), { [MANAGED_ENV]: "1" });
  assert.deepEqual(noSubagentEnv("opencode", {}), { [MANAGED_ENV]: "1", OPENCODE_CONFIG_CONTENT: '{"permission":{"subagent":"deny"}}' });
  const merged = JSON.parse(noSubagentEnv("opencode", { OPENCODE_CONFIG_CONTENT: '{"model":"x","permission":{"bash":"ask"}}' }).OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(merged, { model: "x", permission: { bash: "ask", subagent: "deny" } });
  assert.throws(() => noSubagentEnv("opencode", { OPENCODE_CONFIG_CONTENT: "{bad" }), /not valid JSON/);
  assert.equal(managedEnv({ [MANAGED_ENV]: "1" }), true);
  assert.equal(managedEnv({}), false);
});

test("nativeSubagentCall: Claude Agent and Task, Cursor subagentStart, OpenCode task; never Codex", () => {
  assert.equal(nativeSubagentCall("claude", "pretooluse", { tool_name: "Agent" }), true);
  assert.equal(nativeSubagentCall("claude", "pretooluse", { tool_name: "Task" }), true);
  assert.equal(nativeSubagentCall("claude", "pretooluse", { tool_name: "Bash" }), false);
  assert.equal(nativeSubagentCall("claude", "posttooluse", { tool_name: "Agent" }), false);
  assert.equal(nativeSubagentCall("cursor", "subagentstart", {}), true);
  assert.equal(nativeSubagentCall("opencode", "pretooluse", { tool_name: "task" }), true);
  assert.equal(nativeSubagentCall("opencode", "pretooluse", { tool_name: "Task" }), true);
  assert.equal(nativeSubagentCall("codex", "pretooluse", { tool_name: "spawn_agent" }), false);
});

test("subagentDenial: the Claude PreToolUse deny and the Cursor permission deny", () => {
  assert.deepEqual(subagentDenial("claude"), { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: SUBAGENT_DENIED } });
  assert.deepEqual(subagentDenial("opencode"), subagentDenial("claude"));
  assert.deepEqual(subagentDenial("cursor"), { permission: "deny", user_message: SUBAGENT_DENIED, agent_message: SUBAGENT_DENIED });
});

test("shellHarnessStart: a shell command that starts a harness, past env assignments and wrappers", () => {
  const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
  assert.equal(shellHarnessStart("claude", "pretooluse", bash('codex exec "fix it"')), true);
  assert.equal(shellHarnessStart("claude", "pretooluse", bash("cd /tmp && AI_COLLAB_PARENT=x nohup claude -p hi")), true);
  assert.equal(shellHarnessStart("claude", "pretooluse", bash("/usr/local/bin/opencode run --format json hi")), true);
  assert.equal(shellHarnessStart("claude", "pretooluse", bash("env FOO=1 cursor-agent -p hi")), true);
  assert.equal(shellHarnessStart("claude", "pretooluse", bash("codex --version")), false);
  assert.equal(shellHarnessStart("claude", "pretooluse", bash("grep codex README.md")), false);
  assert.equal(shellHarnessStart("claude", "pretooluse", { tool_name: "Read", tool_input: { file_path: "codex" } }), false);
  assert.equal(shellHarnessStart("opencode", "pretooluse", { tool_name: "bash", tool_input: { command: "claude -p hi" } }), true);
  assert.equal(shellHarnessStart("cursor", "beforeshellexecution", { command: "codex exec hi" }), true);
  assert.equal(shellHarnessStart("codex", "pretooluse", bash("claude -p hi")), false);
});

test("managedShellStartRefusal: refuses a harness argv only in a managed session", () => {
  assert.equal(managedShellStartRefusal(["codex", "exec", "hi"], { [MANAGED_ENV]: "1" }), SHELL_START_DENIED);
  assert.equal(managedShellStartRefusal(["codex", "exec", "hi"], {}), "");
  assert.equal(managedShellStartRefusal(["npm", "test"], { [MANAGED_ENV]: "1" }), "");
});
