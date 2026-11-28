// Auto-mode denials: the SessionStart hint reroutes instead of stopping, and a denial reaches the operator's channel in AFK mode.
import { parseWireEnvelope } from "../lib/agui.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { blockedHint, deniedNote } from "../lib/blocked.ts";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const HOOK = fileURLToPath(new URL("../scripts/ai-collab-hook.mjs", import.meta.url));
const HOOKS = JSON.parse(readFileSync(fileURLToPath(new URL("../hooks/hooks.json", import.meta.url)), "utf8"));
const ALL = "ai-collab-demo--to--all";
const SESSION_ID = "0b5c1f6e-3f1a-4c2e-9d7b-2a8e4f6c1d3a";

const setMode = (fake, mode) => fake.inject(ALL, JSON.stringify({ v: 1, kind: "mode", from: "operator", mode, ts: Date.now() }));
const bodies = (fake) => fake.state.publishes.filter((p) => p.topic === ALL).map((p) => { try { return parseWireEnvelope(p.message)?.body; } catch { return null; } }).filter(Boolean);

function runHook(input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, "--host", "claude"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(input));
  });
}

const denied = { hook_event_name: "PermissionDenied", session_id: SESSION_ID, tool_name: "Edit", tool_input: { file_path: "/repo/test/a.test.mjs" }, reason: "edits an existing test" };

test("hooks.json registers PermissionDenied for Claude as a blocking hook", () => {
  const [entry] = HOOKS.hooks.PermissionDenied;
  assert.match(entry.hooks[0].command, /ai-collab-hook\.mjs" --host claude$/);
  assert.equal(entry.hooks[0].async, undefined);
});

test("blockedHint names ask_question and the patch route for Claude only", () => {
  const hint = blockedHint({ session: "aabbccddeeff0011" }, "claude");
  assert.match(hint, /ask_question tool \(session="aabbccddeeff0011", important=true\)/);
  assert.match(hint, /patch under \$CLAUDE_JOB_DIR\/tmp\//);
  assert.equal(blockedHint({ session: "aabbccddeeff0011" }, "codex"), "");
  assert.equal(blockedHint({}, "claude"), "");
});

test("deniedNote names the session, tool, target and reason, and clips a long command", () => {
  assert.equal(deniedNote(denied, "claude#aabbccddeeff0011"), "auto mode blocked claude#aabbccddeeff0011: Edit /repo/test/a.test.mjs (edits an existing test)");
  const long = deniedNote({ tool_name: "Bash", tool_input: { command: "x".repeat(400) } }, "claude#a");
  assert.equal(long, `auto mode blocked claude#a: Bash ${"x".repeat(300)}…`);
});

test("a PermissionDenied in AFK mode on posts the blocked call to the channel; mode off posts nothing", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "claude", AI_COLLAB_PEERS: "claude,codex", AI_COLLAB_ACTIVITY: "off" });
  const off = await runHook(denied, env);
  assert.deepEqual([off.code, JSON.parse(off.out)], [0, {}]);
  assert.equal(bodies(fake).some((b) => b.startsWith("auto mode blocked")), false);
  setMode(fake, "on");
  const on = await runHook(denied, env);
  assert.deepEqual([on.code, JSON.parse(on.out)], [0, {}]);
  for (let i = 0; i < 100 && !bodies(fake).some((b) => b.startsWith("auto mode blocked")); i++) await delay(10);
  assert.match(bodies(fake).find((b) => b.startsWith("auto mode blocked")) ?? "", /^auto mode blocked claude#[a-f0-9]{16}: Edit \/repo\/test\/a\.test\.mjs \(edits an existing test\)$/);
});
