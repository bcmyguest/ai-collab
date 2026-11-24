// Agent file reads of the task store and state dir are refused with the MCP run_code recipe when the gate is on.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCodeReadRecipe } from "../lib/store-read.mjs";

const HOOK = fileURLToPath(new URL("../scripts/ai-collab-hook.mjs", import.meta.url));
const TASKS = "/home/b/.local/share/ai-collab/tasks/ai-collab.json";
const STATE = "/home/b/.local/state/ai-collab/sessions/cursor/abc.json";
const BUILDERS = "/home/b/.local/state/ai-collab/builders/b1/state.json";
const TASK_RECIPE = runCodeReadRecipe("task_list", {});
const STATE_RECIPE = runCodeReadRecipe("list_sessions", {});

function gateEnv({ setting = true, openshell = true } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "ai-collab-srg-"));
  const config = path.join(home, ".config");
  mkdirSync(path.join(config, "ai-collab"), { recursive: true });
  writeFileSync(path.join(config, "ai-collab", "defaults.json"), JSON.stringify(setting == null ? {} : { readsThroughRunCode: setting }));
  const bin = path.join(home, "bin");
  mkdirSync(bin);
  if (openshell) {
    writeFileSync(path.join(bin, "openshell"), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(bin, "openshell"), 0o755);
  }
  return {
    HOME: home, XDG_CONFIG_HOME: config, PATH: `${bin}:${path.dirname(process.execPath)}`,
    AI_COLLAB_OPENSHELL_BIN: "",
  };
}

function runHook(args, input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out: out.trim() }));
    child.stdin.end(JSON.stringify(input));
  });
}

const read = (file) => ({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: file } });

function recipeOf(host, output) {
  if (host === "cursor") return output.permission === "deny" ? output.agent_message : "";
  return output.hookSpecificOutput?.permissionDecision === "deny" ? output.hookSpecificOutput.permissionDecisionReason : "";
}

test("an agent read of the task store and of the state dir is refused with the run_code recipe when the gate is on", async () => {
  const env = gateEnv();
  const cases = [
    [["--read-gate", "--host", "claude"], read(TASKS), "claude", TASK_RECIPE],
    [["--read-gate", "--host", "claude"], read(STATE), "claude", STATE_RECIPE],
    [["--read-gate", "--host", "claude"], { hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: { pattern: "x", path: STATE } }, "claude", STATE_RECIPE],
    [["--read-gate", "--host", "claude"], { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `cat ${TASKS} | jq .` } }, "claude", TASK_RECIPE],
    [["--host", "codex"], read(TASKS), "codex", TASK_RECIPE],
    [["--read-gate", "--host", "cursor"], { hook_event_name: "beforeReadFile", file_path: TASKS }, "cursor", TASK_RECIPE],
    [["--read-gate", "--host", "cursor"], { hook_event_name: "beforeReadFile", file_path: STATE }, "cursor", STATE_RECIPE],
    [["--read-gate", "--host", "cursor"], { hook_event_name: "preToolUse", tool_name: "Grep", tool_input: { path: STATE, pattern: "id" } }, "cursor", STATE_RECIPE],
    [["--read-gate", "--host", "cursor"], { hook_event_name: "beforeShellExecution", command: `jq . ${STATE}` }, "cursor", STATE_RECIPE],
  ];
  for (const [args, input, host, recipe] of cases) {
    const result = await runHook(args, input, env);
    assert.equal(result.code, 0, args.join(" "));
    const output = JSON.parse(result.out);
    assert.equal(recipeOf(host, output), recipe, `${args.join(" ")} ${input.hook_event_name}`);
    if (host === "cursor") assert.equal(output.user_message, recipe);
  }
});

test("the same store read is allowed when OpenShell is not required", async () => {
  const reads = [
    [["--read-gate", "--host", "claude"], read(TASKS)],
    [["--read-gate", "--host", "claude"], read(STATE)],
    [["--read-gate", "--host", "cursor"], { hook_event_name: "beforeReadFile", file_path: TASKS }],
    [["--read-gate", "--host", "cursor"], { hook_event_name: "beforeShellExecution", command: `cat ${STATE}` }],
  ];
  for (const opts of [{ setting: true, openshell: false }, { setting: null, openshell: true }]) {
    const env = gateEnv(opts);
    for (const [args, input] of reads) {
      const result = await runHook(args, input, env);
      assert.equal(result.out, "{}", `${JSON.stringify(opts)} ${input.hook_event_name}`);
    }
  }
});

test("builder state, a project file, and an ordinary shell stay allowed when the gate is on", async () => {
  const env = gateEnv();
  const allowed = [
    [["--read-gate", "--host", "claude"], read(BUILDERS)],
    [["--read-gate", "--host", "claude"], read("/home/b/ai-collab/lib/store-read.mjs")],
    [["--read-gate", "--host", "claude"], { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ai-collab send all hi" } }],
    [["--read-gate", "--host", "claude"], { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `ls ${BUILDERS}` } }],
    [["--read-gate", "--host", "cursor"], { hook_event_name: "beforeReadFile", file_path: BUILDERS }],
    [["--read-gate", "--host", "cursor"], { hook_event_name: "beforeShellExecution", command: "git status" }],
    [["--read-gate", "--host", "cursor"], { hook_event_name: "preToolUse", tool_name: "Send", tool_input: { body: "hi" } }],
  ];
  for (const [args, input] of allowed) {
    const result = await runHook(args, input, env);
    assert.equal(result.out, "{}", `${input.hook_event_name} ${input.tool_name || input.command || input.file_path}`);
  }
});
