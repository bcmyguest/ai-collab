// S2 backstop: a harness that inherits AI_COLLAB_MANAGED=1 through a wrapper the shell gate misses refuses to start.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, sessionLabel, stateDir } from "../lib/config.mjs";
import { processStart } from "../lib/process.mjs";
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
  assert.equal(managedStartAllowed(managed, parent), true);
  assert.equal(managedStartAllowed(managed, parent), true, "a second thread of the same app-server");
  assert.equal(managedStartAllowed(managed, { pid: 101, start: "9" }), false);
  assert.equal(managedStartAllowed({ ...managed, [MANAGED_TICKET_ENV]: "0".repeat(32) }, parent), false, "an unknown ticket");
  assert.equal(managedStartAllowed({ ...managed, [MANAGED_TICKET_ENV]: "../x" }, parent), false, "a malformed ticket");
});

test("a managed start without a ticket is refused even when the session has a live owned record", (t) => {
  const env = setup(t);
  const id = "81111111-2222-3333-4444-555555555555";
  const label = sessionLabel(id);
  writeOwned(loadConfig(env, where(id)), { v: 1, label, address: `claude#${label}`, harness: "claude", nativeId: id, project: "demo", managed: true, status: "idle" });
  // A grandchild that unset the ticket and resumes its parent's session id.
  assert.equal(managedStartAllowed({ ...env, [MANAGED_ENV]: "1" }, { pid: 5, start: "1" }), false);
  assert.equal(managedStartAllowed({ ...env, [MANAGED_ENV]: "1", [MANAGED_TICKET_ENV]: "0".repeat(32) }, { pid: 5, start: "1" }), false, "a ticket with no file");
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

// The top-level keys of session-start.command.output in codex-cli 0.171.0, which sets additionalProperties: false.
const CODEX_SESSION_START_KEYS = new Set(["continue", "stopReason", "suppressOutput", "systemMessage", "hookSpecificOutput"]);

test("a Codex SessionStart refusal uses only fields Codex's output schema accepts", async (t) => {
  const env = { ...setup(t), AI_COLLAB_PEER: "codex" };
  const r = await runHook(["--host", "codex"], { ...start("41111111-2222-3333-4444-555555555555"), model: "gpt-test", permission_mode: "default", transcript_path: null }, { ...env, [MANAGED_ENV]: "1" });
  assert.deepEqual(r, { continue: false, stopReason: MANAGED_START_REFUSED });
  assert.deepEqual(Object.keys(r).filter((k) => !CODEX_SESSION_START_KEYS.has(k)), []);
});

test("an owned session binds its ticket, so a grandchild with the inherited env is refused even for that session", (t) => {
  const env = setup(t);
  const id = "91111111-2222-3333-4444-555555555555";
  const label = sessionLabel(id);
  writeOwned(loadConfig(env, where(id)), { v: 1, label, address: `claude#${label}`, harness: "claude", nativeId: id, project: "demo", managed: true, status: "idle" });
  const child = { ...env, [MANAGED_ENV]: "1", [MANAGED_TICKET_ENV]: mintManagedTicket(env) };
  assert.equal(managedStartAllowed(child, { pid: 5, start: "1" }), true);
  assert.equal(managedStartAllowed(child, { pid: 5, start: "1" }), true, "the same harness starts again (resume, compact)");
  assert.equal(managedStartAllowed(child, { pid: 6, start: "1" }), false);
  assert.equal(managedStartAllowed(child, { pid: 6, start: "1" }), false, "a grandchild resuming the owned session");
});

test("minting prunes tickets whose harness process has exited and keeps those of a running one", (t) => {
  const env = setup(t);
  const dir = join(stateDir(env), "managed-tickets");
  const gone = mintManagedTicket(env);
  const live = mintManagedTicket(env);
  writeFileSync(join(dir, `${gone}.bound`), JSON.stringify({ pid: 999_999_999, start: "1" }));
  writeFileSync(join(dir, `${live}.bound`), JSON.stringify({ pid: process.pid, start: processStart(process.pid) }));
  mintManagedTicket(env);
  assert.deepEqual([`${gone}.json`, `${gone}.bound`].map((f) => existsSync(join(dir, f))), [false, false]);
  assert.deepEqual([`${live}.json`, `${live}.bound`].map((f) => existsSync(join(dir, f))), [true, true]);
});

test("without a process identity (no /proc) a ticket stays unbound, so the harness's later starts pass", (t) => {
  const env = setup(t);
  const child = { ...env, [MANAGED_ENV]: "1", [MANAGED_TICKET_ENV]: mintManagedTicket(env) };
  assert.equal(managedStartAllowed(child, { pid: 5, start: null }), true);
  assert.equal(managedStartAllowed(child, { pid: 6, start: null }), true, "the hook's parent shell differs per hook run");
  assert.equal(managedStartAllowed({ ...env, [MANAGED_ENV]: "1" }, { pid: 5, start: null }), false, "still no start without a ticket");
});

test("minting keeps a ticket older than 7 days while its bound harness is running", (t) => {
  const env = setup(t);
  const dir = join(stateDir(env), "managed-tickets");
  const old = mintManagedTicket(env);
  const unused = mintManagedTicket(env);
  writeFileSync(join(dir, `${old}.bound`), JSON.stringify({ pid: process.pid, start: processStart(process.pid) }));
  const aged = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  for (const f of [`${old}.json`, `${old}.bound`, `${unused}.json`]) utimesSync(join(dir, f), aged, aged);
  mintManagedTicket(env);
  assert.deepEqual([`${old}.json`, `${old}.bound`].map((f) => existsSync(join(dir, f))), [true, true]);
  assert.equal(existsSync(join(dir, `${unused}.json`)), false, "an unused ticket still ages out");
});
