import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig } from "../lib/config.mjs";
import { sendMessage } from "../lib/inbox.mjs";

const HOOK = fileURLToPath(new URL("../scripts/ai-collab-hook.mjs", import.meta.url));

function runHook(input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, "--host", "claude"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(input));
  });
}

test("subagent hook leaves the root session's message queued for the root hook", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const aliceEnv = peerEnv(fake, { peer: "alice" });
  const bobEnv = peerEnv(fake, { peer: "bob" });
  await sendMessage(loadConfig(bobEnv), "alice", "for the root only");

  const sub = await runHook({
    hook_event_name: "PostToolUse",
    session_id: "s-root",
    agent_id: "agent-1",
    agent_type: "general-purpose",
    tool_name: "Bash",
  }, aliceEnv);
  assert.equal(sub.code, 0);
  assert.deepEqual(JSON.parse(sub.out), {}, "subagent gets neutral output");
  assert.equal(sub.out.includes("for the root only"), false);

  const root = await runHook({ hook_event_name: "UserPromptSubmit", session_id: "s-root" }, aliceEnv);
  const obj = JSON.parse(root.out);
  assert.match(obj.hookSpecificOutput.additionalContext, /body="for the root only"/);
});
