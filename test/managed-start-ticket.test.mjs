// S2 backstop: a harness that inherits AI_COLLAB_MANAGED=1 through a wrapper the shell gate misses refuses to start.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { writeOwned } from "../lib/sessions/registry.ts";
import {
  MANAGED_ENV, MANAGED_START_REFUSED, MANAGED_TICKET_ENV, managedStartAllowed, mintManagedTicket, noSubagentEnv, shellHarnessStart,
} from "../lib/subagent-guard.ts";

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

function setup(t) {
  const home = mkdtempSync(join(tmpdir(), "ai-collab-ticket-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return {
    PATH: process.env.PATH, HOME: home, AI_COLLAB_URL: "http://127.0.0.1:9", AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "claude",
    AI_COLLAB_STATE_DIR: join(home, "state"), AI_COLLAB_TIMEOUT_MS: "500", AI_COLLAB_ACTIVITY: "off",
  };
}

const start = (id) => ({ hook_event_name: "SessionStart", session_id: id, cwd: "/tmp", source: "startup" });
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
const where = (id) => ({ cwd: "/tmp", host: "claude", session: sessionLabel(id) });

test("a SessionStart with AI_COLLAB_MANAGED=1, no ticket and no owned record refuses to start", async (t) => {
  const env = setup(t);
  const r = await runHook(["--host", "claude"], start("11111111-2222-3333-4444-555555555555"), { ...env, [MANAGED_ENV]: "1" });
  assert.deepEqual(r, { continue: false, stopReason: MANAGED_START_REFUSED });
});

test("a SessionStart with a fresh ticket starts; an operator SessionStart is untouched", async (t) => {
  const env = setup(t);
  const ticket = mintManagedTicket(env);
  const r = await runHook(["--host", "claude"], start("21111111-2222-3333-4444-555555555555"), { ...env, [MANAGED_ENV]: "1", [MANAGED_TICKET_ENV]: ticket });
  assert.notEqual(r?.continue, false);
  const plain = await runHook(["--host", "claude"], start("31111111-2222-3333-4444-555555555555"), env);
  assert.notEqual(plain?.continue, false);
});

test("a ticket binds to the first harness process; another process with the inherited ticket is refused", (t) => {
  const env = setup(t);
  const ticket = mintManagedTicket(env);
  const managed = { ...env, [MANAGED_ENV]: "1", [MANAGED_TICKET_ENV]: ticket };
  const parent = { pid: 100, start: "7" };
  assert.equal(managedStartAllowed(managed, where("41111111-2222-3333-4444-555555555555"), parent), true);
  assert.equal(managedStartAllowed(managed, where("51111111-2222-3333-4444-555555555555"), parent), true, "a second thread of the same app-server");
  assert.equal(managedStartAllowed(managed, where("61111111-2222-3333-4444-555555555555"), { pid: 101, start: "9" }), false);
  assert.equal(managedStartAllowed({ ...managed, [MANAGED_TICKET_ENV]: "0".repeat(32) }, where("71111111-2222-3333-4444-555555555555"), parent), false, "an unknown ticket");
  assert.equal(managedStartAllowed({ ...managed, [MANAGED_TICKET_ENV]: "../x" }, where("71111111-2222-3333-4444-555555555555"), parent), false, "a malformed ticket");
});

test("a live owned record authorizes a managed start without a ticket", (t) => {
  const env = setup(t);
  const id = "81111111-2222-3333-4444-555555555555";
  const label = sessionLabel(id);
  writeOwned(loadConfig(env, where(id)), { v: 1, label, address: `claude#${label}`, harness: "claude", nativeId: id, project: "demo", managed: true, status: "starting" });
  assert.equal(managedStartAllowed({ ...env, [MANAGED_ENV]: "1" }, where(id), { pid: 5, start: "1" }), true);
});

test("noSubagentEnv mints a ticket for every managed start", (t) => {
  const env = setup(t);
  const a = noSubagentEnv("claude", env)[MANAGED_TICKET_ENV];
  const b = noSubagentEnv("codex", env)[MANAGED_TICKET_ENV];
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

test("shell segments split outside quotes only", () => {
  assert.equal(shellHarnessStart("claude", "pretooluse", bash('git commit -m "x; codex exec y"')), false);
  assert.equal(shellHarnessStart("claude", "pretooluse", bash("echo 'a && claude -p hi' | wc -l")), false);
  assert.equal(shellHarnessStart("claude", "pretooluse", bash('ls; codex exec "go"')), true);
  assert.equal(shellHarnessStart("claude", "pretooluse", bash('echo "a" && claude -p hi')), true);
});

test("harness subcommands that start no session are allowed", () => {
  for (const command of ["claude mcp list", "claude doctor", "codex login status", "codex mcp list", "opencode models", "opencode auth list"]) {
    assert.equal(shellHarnessStart("claude", "pretooluse", bash(command)), false, command);
  }
  for (const command of ["claude -p hi", "codex exec hi", "codex resume x", "opencode run hi", "opencode"]) {
    assert.equal(shellHarnessStart("claude", "pretooluse", bash(command)), true, command);
  }
});
