import assert from "node:assert/strict";
import { test } from "node:test";
import { agentHarness, assertHostAgent, hostAgentRefusal, unsafeAgentFlags } from "../lib/agent-guard.mjs";

test("each harness's approval-off flags are found by binary name, wherever the binary lives", () => {
  assert.deepEqual(unsafeAgentFlags(["/home/b/.local/bin/cursor-agent", "-p", "--force", "--trust", "tick"]), ["--force"]);
  assert.deepEqual(unsafeAgentFlags(["agent", "-p", "--yolo", "x"]), ["--yolo"]);
  assert.deepEqual(unsafeAgentFlags(["cursor-agent", "-p", "--sandbox", "disabled", "x"]), ["--sandbox disabled"]);
  assert.deepEqual(unsafeAgentFlags(["claude", "-p", "--dangerously-skip-permissions", "x"]), ["--dangerously-skip-permissions"]);
  assert.deepEqual(unsafeAgentFlags(["claude", "-p", "--permission-mode=bypassPermissions", "x"]), ["--permission-mode bypassPermissions"]);
  assert.deepEqual(unsafeAgentFlags(["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "x"]), ["--dangerously-bypass-approvals-and-sandbox"]);
  assert.deepEqual(unsafeAgentFlags(["codex", "exec", "-s", "danger-full-access", "x"]), ["-s danger-full-access"]);
  assert.deepEqual(unsafeAgentFlags(["opencode", "run", "--auto", "x"]), ["--auto"]);
});

test("safe argvs pass: the UI's fixed templates, Codex hook trust, a prompt that names a flag, other programs", () => {
  assert.deepEqual(unsafeAgentFlags(["codex", "exec", "--json", "--dangerously-bypass-hook-trust", "hi"]), []);
  assert.deepEqual(unsafeAgentFlags(["cursor-agent", "-p", "--trust", "--output-format", "stream-json", "hi"]), []);
  assert.deepEqual(unsafeAgentFlags(["claude", "--bg", "explain --force in git push"]), []);
  assert.deepEqual(unsafeAgentFlags(["/home/b/.config/ai-collab/steward.sh", "--force"]), []);
  assert.deepEqual(unsafeAgentFlags(["git", "push", "--force"]), []);
  assert.equal(agentHarness(["npx", "claude"]), "");
});

test("the refusal names the flag and both ways out; a sandbox or AI_COLLAB_ALLOW_HOST_AGENT=1 lifts it", () => {
  const argv = ["cursor-agent", "-p", "--force", "tick"];
  const refusal = hostAgentRefusal(argv, { env: {} });
  assert.match(refusal, /cursor with --force on the host/);
  assert.match(refusal, /"sandbox": true/);
  assert.match(refusal, /AI_COLLAB_ALLOW_HOST_AGENT=1/);
  assert.equal(hostAgentRefusal(argv, { sandboxed: true, env: {} }), "");
  assert.equal(hostAgentRefusal(argv, { env: { AI_COLLAB_ALLOW_HOST_AGENT: "1" } }), "");
  assert.equal(hostAgentRefusal(argv, { env: { AI_COLLAB_ALLOW_HOST_AGENT: "yes" } }), refusal);
  assert.throws(() => assertHostAgent(argv, { env: {} }), (error) => error.code === "EHOSTAGENT");
});
