import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resetScopeProbe, scopeAvailable, systemdRunOnPath } from "../lib/sessions/scope.ts";
import { runCommand } from "../runner/schedules.mjs";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "ai-collab-sched-scope-"));

// The stand-in for systemd-run: records its argv, then runs the command after `--` with the caller's stdio and exit
// code, which is what the real one does in a scope. It also reports the PID it saw, which an exec keeps.
const SYSTEMD_RUN = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ argv, pid: process.pid }) + "\\n");
const at = argv.indexOf("--");
if (at < 0) process.exit(64); // the real systemd-run refuses a command without the separator
const [file, ...args] = argv.slice(at + 1);
const run = spawnSync(file, args, { stdio: "inherit" });
process.exit(run.status === null ? 1 : run.status);
`;

// A bin directory holding an optional fake systemd-run, a user manager socket, and the env a runner unit would have.
function binDir({ systemdRun = true } = {}) {
  const dir = tmp();
  const bin = path.join(dir, "bin");
  const runtime = path.join(dir, "run");
  mkdirSync(bin);
  mkdirSync(runtime);
  writeFileSync(path.join(runtime, "bus"), "");
  const record = path.join(dir, "runs.jsonl");
  if (systemdRun) {
    writeFileSync(path.join(bin, "systemd-run"), SYSTEMD_RUN);
    chmodSync(path.join(bin, "systemd-run"), 0o755);
  }
  const env = {
    HOME: dir, PATH: [bin, path.dirname(process.execPath)].join(path.delimiter), FAKE_RECORD: record,
    XDG_RUNTIME_DIR: runtime, INVOCATION_ID: "0".repeat(32), TMPDIR: dir,
  };
  const calls = () => (existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { dir, bin, env, record, calls };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function eventually(check, ms = 15000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await delay(20);
  }
}

test("a scheduled command runs in its own scope, keeping its exit code and output", async () => {
  const { env, calls, dir } = binDir();
  resetScopeProbe();
  const scope = { env, label: "pm", description: "AI Collab schedule pm" };
  const result = await runCommand([process.execPath, "-e", "console.log('tick ran'); process.exit(3)"], { cwd: dir, env, timeoutMs: 10_000, scope });
  assert.deepEqual([result.ok, result.exitCode], [false, 3], "the command's own exit code comes through systemd-run");
  assert.match(result.tail, /tick ran/);
  const call = calls().find((run) => run.argv.some((arg) => arg.startsWith("--unit=ai-collab-schedule-pm-")));
  assert.ok(call, "the command is launched through systemd-run");
  assert.deepEqual(call.argv.slice(0, 4), ["--user", "--scope", "--quiet", "--collect"]);
  // The timeout goes to systemd too: a scoped command must not outlive its deadline when the runner dies first.
  assert.ok(call.argv.includes("--property=RuntimeMaxSec=10"), "the timeout is handed to systemd");
  const at = call.argv.indexOf("--");
  assert.equal(call.argv[at + 1], process.execPath);
  assert.deepEqual(call.argv.slice(at + 2), ["-e", "console.log('tick ran'); process.exit(3)"]);
});

test("without systemd-run a scheduled command runs exactly as before", async () => {
  const { env, calls, dir } = binDir({ systemdRun: false });
  resetScopeProbe();
  const result = await runCommand([process.execPath, "-e", "console.log('plain')"], { cwd: dir, env, timeoutMs: 10_000, scope: { env, label: "pm" } });
  assert.deepEqual([result.ok, result.exitCode], [true, 0]);
  assert.match(result.tail, /plain/);
  assert.deepEqual(calls(), [], "nothing wrapped the command");
});

test("a timeout still cuts a scoped command through its process group", async () => {
  const { env, dir } = binDir();
  resetScopeProbe();
  const slow = await runCommand([process.execPath, "-e", "setTimeout(() => {}, 60000)"], {
    cwd: dir, env, timeoutMs: 300, graceMs: 200, scope: { env, label: "pm" },
  });
  assert.deepEqual([slow.ok, slow.timedOut], [false, true], "a stuck agent is still cut at its timeout");
});

// The property a fake cannot show: on a host with a real user manager the agent runs in a cgroup of its own, so
// stopping the runner's cgroup leaves it running. Skips where no scope can be made.
test("a scheduled agent outlives a stop of the unit that started it, on real systemd", async (t) => {
  resetScopeProbe();
  const real = { ...process.env, AI_COLLAB_SCOPE: "on" };
  if (!scopeAvailable({ env: real }).ok) {
    t.skip("systemd-run cannot make a scope here");
    return;
  }
  const realSystemdRun = systemdRunOnPath(real.PATH);
  const dir = tmp();
  const pidFile = path.join(dir, "agent.pid");
  const script = path.join(dir, "runner.mjs");
  // Stand-in for the runner: one scheduled command, started from inside the unit that a deploy restarts.
  writeFileSync(script, `
import { runCommand } from ${JSON.stringify(new URL("../runner/schedules.mjs", import.meta.url).href)};
const env = process.env;
await runCommand([process.execPath, "-e", "require('node:fs').writeFileSync(process.env.PID_FILE, String(process.pid)); setTimeout(() => {}, 120000)"], {
  cwd: process.env.RUN_DIR, env, timeoutMs: 180_000, scope: { env, label: "pm", description: "AI Collab schedule pm" },
});
setTimeout(() => {}, 120000);
`);
  const unit = `ai-collab-test-runner-${process.pid}-${Date.now()}`;
  const vars = { HOME: dir, PATH: real.PATH, PID_FILE: pidFile, RUN_DIR: dir, AI_COLLAB_SCOPE: "on" };
  // A service unit inherits nothing from the caller, so its environment goes on the command line.
  const setenv = Object.entries(vars).flatMap(([key, value]) => [`--setenv=${key}=${value}`]);
  const runner = spawn(realSystemdRun, ["--user", "--quiet", "--unit", unit, ...setenv, "--", process.execPath, script], { stdio: "ignore", detached: true });
  runner.unref();
  t.after(() => { try { execFileSync("systemctl", ["--user", "stop", unit], { env: real, stdio: "ignore" }); } catch { /* gone */ } });
  await eventually(() => existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, "utf8"));
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });
  assert.ok(alive(pid), "the scheduled agent runs");
  const agentCgroup = readFileSync(`/proc/${pid}/cgroup`, "utf8");
  assert.match(agentCgroup, /ai-collab-schedule-pm-/, "the agent runs in its own transient scope");
  assert.doesNotMatch(agentCgroup, new RegExp(unit), "the agent is not in the runner unit's cgroup");
  // The deploy: the runner unit is restarted, which kills its cgroup. The agent is outside it and keeps working.
  execFileSync("systemctl", ["--user", "stop", unit], { env: real, stdio: "ignore" });
  await delay(700);
  assert.equal(alive(pid), true, "the scheduled agent outlives the runner");
});
