import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sessionLabel } from "../lib/config.ts";
import { SUBAGENT_TOOL_HINT, childHint, subagentToolHint } from "../lib/family.ts";
import { recordSession } from "../lib/sessions/registry.ts";
import { MANAGED_ENV } from "../lib/subagent-guard.ts";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const HOOK = fileURLToPath(new URL("../scripts/ai-collab-hook.mjs", import.meta.url));
const ID = "33333333-3333-4333-8333-333333333333";
const STEER = "spawn_agent starts a Claude, Codex, Cursor or OpenCode child (harness:model) that nests under this thread and reports back; "
  + "prefer it over your native subagent tool when another harness or model suits the task.";
const TOOL_HINT = "[ai-collab] Native subagents run Claude only. For a Codex, Cursor or OpenCode child, or another model, "
  + "call the ai-collab spawn_agent tool (harness:model, brief); the child nests under this thread and reports back.";

function runHook(args, input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => resolve(JSON.parse(out)));
    child.stdin.end(JSON.stringify(input));
  });
}

const context = (out) => out.hookSpecificOutput?.additionalContext || out.additional_context || "";
const self = () => {
  const text = readFileSync("/proc/self/stat", "utf8");
  return { pid: process.pid, start: text.slice(text.lastIndexOf(")") + 2).split(" ")[19] };
};

test("the session start hint steers toward spawn_agent for another harness or model", () => {
  assert.ok(childHint({ session: "aaaaaaaaaaaaaaaa" }).endsWith(` ${STEER}`));
  assert.equal(SUBAGENT_TOOL_HINT, TOOL_HINT);
});

test("subagentToolHint fires once per registered session and survives later hook writes", async () => {
  const cfg = { stateDir: tempDir({ after }, "ai-collab-steer-"), project: "proj", peer: "claude", peers: [], session: sessionLabel(ID), auto: false };
  assert.equal(await subagentToolHint({ ...cfg, session: "" }), "");
  assert.equal(await subagentToolHint(cfg), "", "unregistered");
  await recordSession(cfg, { id: ID, cwd: "/tmp", harness: "claude", event: "SessionStart", proc: self() });
  assert.equal(await subagentToolHint(cfg), TOOL_HINT);
  await recordSession(cfg, { id: ID, cwd: "/tmp", harness: "claude", event: "PostToolUse", proc: self() });
  assert.equal(await subagentToolHint(cfg), "");
});

test("the Claude read gate adds the hint to the first Agent call only and never blocks", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "claude", AI_COLLAB_PEERS: "claude,codex" });
  const base = { session_id: ID, cwd: "/tmp/proj" };
  const start = await runHook(["--host", "claude"], { ...base, hook_event_name: "SessionStart" }, env);
  assert.ok(context(start).includes(STEER));

  const gate = (input, e = env) => runHook(["--read-gate", "--host", "claude"], { ...base, hook_event_name: "PreToolUse", ...input }, e);
  assert.deepEqual(await gate({ tool_name: "Bash", tool_input: { command: "ls" } }), {});
  assert.deepEqual(await gate({ tool_name: "Agent", tool_input: { prompt: "x" }, agent_id: "sub-1" }), {});
  const first = await gate({ tool_name: "Agent", tool_input: { prompt: "x" } });
  assert.equal(context(first), TOOL_HINT);
  assert.equal(first.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(first.hookSpecificOutput.permissionDecision, undefined);
  assert.deepEqual(await gate({ tool_name: "Task", tool_input: { prompt: "x" } }), {});
  assert.deepEqual(await gate({ tool_name: "Agent", tool_input: { prompt: "x" } }), {});

  // A managed session still gets the denial, not the hint.
  const managed = await gate({ tool_name: "Agent", tool_input: { prompt: "x" } }, { ...env, [MANAGED_ENV]: "1" });
  assert.equal(managed.hookSpecificOutput?.permissionDecision, "deny");
});
