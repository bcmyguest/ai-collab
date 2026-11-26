import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resetScopeProbe, scopeAvailable, scopeLaunch, scopeSupport, scopeUnitName, scopeWrap, systemdRunOnPath } from "../lib/sessions.ts";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "ai-collab-scope-"));
const UNIT = /^ai-collab-[a-z]+(-[a-z0-9-]+)*-\d{8}T\d{6}Z-[0-9a-f]{6}$/;

// Records its argv as JSON, then execs the command after `--` so the caller sees the real exit code and stdio.
const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ argv, pid: process.pid }) + "\\n");
if (process.env.FAKE_SYSTEMD_RUN_FAIL) {
  process.stderr.write(process.env.FAKE_SYSTEMD_RUN_FAIL + "\\n");
  process.exit(1);
}
const at = argv.indexOf("--");
const [file, ...args] = argv.slice(at + 1);
const { spawnSync } = require("node:child_process");
const r = spawnSync(file, args, { stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);
`;

// Runs a scope decision with a fake systemd-run on PATH and the env a systemd service would have.
function binSetup({ fail = "" } = {}) {
  const dir = tmp();
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const record = path.join(dir, "runs.jsonl");
  writeFileSync(path.join(bin, "systemd-run"), FAKE);
  chmodSync(path.join(bin, "systemd-run"), 0o755);
  const runtime = path.join(dir, "run");
  mkdirSync(runtime);
  writeFileSync(path.join(runtime, "bus"), "");
  const env = {
    PATH: [bin, path.dirname(process.execPath)].join(path.delimiter),
    FAKE_RECORD: record, XDG_RUNTIME_DIR: runtime, INVOCATION_ID: "0".repeat(32),
    ...(fail ? { FAKE_SYSTEMD_RUN_FAIL: fail } : {}),
  };
  const runs = () => (existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { env, bin, record, runs, dir };
}

test("unit names are legal, unique and carry the label", () => {
  const name = scopeUnitName("session", Date.UTC(2026, 10, 22, 19, 4, 5, 678), "claude");
  assert.match(name, UNIT);
  assert.match(name, /^ai-collab-session-claude-20261122T190405Z-/);
  assert.match(scopeUnitName("schedule", Date.now(), "PM tick / nightly"), UNIT);
  assert.match(scopeUnitName("schedule", Date.now(), "PM tick / nightly"), /-pm-tick-nightly-/);
  // Two starts in the same second still differ: the scope name must never collide.
  const at = Date.now();
  assert.notEqual(scopeUnitName("session", at, "codex"), scopeUnitName("session", at, "codex"));
  assert.match(scopeUnitName("session", at, "x".repeat(80)), UNIT);
});

test("scopeSupport explains each refusal and honours AI_COLLAB_SCOPE", () => {
  const systemdRun = "/usr/bin/systemd-run";
  const unit = { INVOCATION_ID: "abc", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" };
  assert.deepEqual(scopeSupport({ env: unit, systemdRun }), { ok: true, why: "systemd-run --user --scope" });
  assert.equal(scopeSupport({ env: unit, systemdRun: "" }).ok, false);
  assert.match(scopeSupport({ env: unit, systemdRun: "" }).why, /not installed/);
  assert.match(scopeSupport({ env: { INVOCATION_ID: "abc" }, systemdRun }).why, /no systemd user manager/);
  assert.match(scopeSupport({ env: { INVOCATION_ID: "abc", XDG_RUNTIME_DIR: "/nonexistent" }, systemdRun }).why, /no systemd user manager/);
  // A process started by hand has no cgroup to leave, so nothing to scope; AI_COLLAB_SCOPE=on still asks for one.
  assert.match(scopeSupport({ env: { DBUS_SESSION_BUS_ADDRESS: unit.DBUS_SESSION_BUS_ADDRESS }, systemdRun }).why, /not started by systemd/);
  assert.equal(scopeSupport({ env: { ...unit, AI_COLLAB_SCOPE: "on" }, systemdRun }).ok, true);
  assert.deepEqual(scopeSupport({ env: { ...unit, AI_COLLAB_SCOPE: "off" }, systemdRun }), { ok: false, why: "AI_COLLAB_SCOPE=off" });
  assert.match(scopeSupport({ env: { ...unit, AI_COLLAB_SCOPE: "yes" }, systemdRun }).why, /must be on or off/);
});

test("the wrapper separates the command with -- and keeps a harness flag out of systemd-run", () => {
  const [file, args] = scopeWrap(["/bin/claude", "--bg", "-m", "x y"], { systemdRun: "/usr/bin/systemd-run", unit: "ai-collab-session-x-1", cwd: "/r", description: "AI Collab claude session" });
  assert.equal(file, "/usr/bin/systemd-run");
  assert.deepEqual(args, [
    "--user", "--scope", "--quiet", "--collect", "--unit=ai-collab-session-x-1",
    "--description=AI Collab claude session", "--working-directory=/r", "--", "/bin/claude", "--bg", "-m", "x y",
  ]);
  assert.deepEqual(scopeWrap(["/bin/x"], { systemdRun: "/s", unit: "u" })[1].slice(-3), ["--unit=u", "--", "/bin/x"]);
  // A scoped command outlives its caller, so its deadline is systemd's too; seconds, rounded up, never below 1.
  assert.deepEqual(scopeWrap(["/bin/x"], { systemdRun: "/s", unit: "u", runtimeMaxSec: 900.2 })[1].slice(5, 6), ["--property=RuntimeMaxSec=901"]);
  assert.deepEqual(scopeWrap(["/bin/x"], { systemdRun: "/s", unit: "u", runtimeMaxSec: 0.4 })[1].slice(5, 6), ["--property=RuntimeMaxSec=1"]);
  assert.equal(scopeWrap(["/bin/x"], { systemdRun: "/s", unit: "u" })[1].some((arg) => arg.startsWith("--property=")), false);
});

test("scopeLaunch finds systemd-run on the env's PATH and falls back with a reason", () => {
  const { env } = binSetup();
  assert.equal(systemdRunOnPath(env.PATH), path.join(env.PATH.split(path.delimiter)[0], "systemd-run"));
  const launch = scopeLaunch(["/bin/claude", "--bg", "hi"], { env, at: Date.UTC(2026, 10, 22, 19, 4, 5), label: "claude" });
  assert.equal(launch.scoped, true);
  assert.match(launch.unit, UNIT);
  assert.equal(launch.args.at(-1), "hi");
  assert.deepEqual(launch.args.slice(0, 5), ["--user", "--scope", "--quiet", "--collect", `--unit=${launch.unit}`]);
  // A bare PATH has no systemd-run: the plain command comes back untouched with the reason.
  const plain = scopeLaunch(["/bin/claude", "--bg", "hi"], { env: { ...env, PATH: path.dirname(process.execPath) } });
  assert.deepEqual([plain.file, plain.args, plain.scoped], ["/bin/claude", ["--bg", "hi"], false]);
  assert.match(plain.why, /not installed/);
});

test("a live probe falls back when systemd-run is present but cannot reach its manager", () => {
  const { env } = binSetup({ fail: "Failed to connect to bus: No medium found" });
  // A separate PATH source keeps this probe from reading the passing verdict cached for the other fake.
  resetScopeProbe();
  const systemdRun = systemdRunOnPath(env.PATH);
  const verdict = scopeAvailable({ env, systemdRun });
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /Failed to connect to bus/);
  const launch = scopeLaunch(["/bin/claude", "--bg", "hi"], { env });
  assert.deepEqual([launch.file, launch.args, launch.scoped], ["/bin/claude", ["--bg", "hi"], false]);
  assert.match(launch.why, /cannot make a scope/);
});

test("a scoped command inherits stdio and its exact exit code through the wrapper", async () => {
  const { env, runs } = binSetup();
  resetScopeProbe();
  const launch = scopeLaunch([process.execPath, "-e", "console.log('out'); console.error('err'); process.exit(7)"], { env, label: "codex" });
  assert.equal(launch.scoped, true);
  const { spawn } = await import("node:child_process");
  const child = spawn(launch.file, launch.args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 7, "the caller sees the payload's exit code, not systemd-run's");
  assert.deepEqual([out.trim(), err.trim()], ["out", "err"]);
  // One probe at startup, then the real launch: the probe is cached, so a start costs one systemd-run.
  const recorded = runs();
  assert.equal(recorded.length, 2);
  assert.match(recorded[0].argv.join(" "), /ai-collab-probe-/);
  assert.match(recorded[1].argv.join(" "), /--unit=ai-collab-session-codex-/);
  assert.equal(recorded[1].argv.includes("--"), true);
});

test("the probe runs once per binary, re-asks after resetScopeProbe, and retries a failure later", async () => {
  const { env, runs } = binSetup();
  resetScopeProbe();
  await delay(0);
  assert.equal(scopeAvailable({ env, systemdRun: systemdRunOnPath(env.PATH) }).ok, true);
  assert.equal(scopeAvailable({ env, systemdRun: systemdRunOnPath(env.PATH) }).ok, true);
  assert.equal(runs().length, 1, "a passing probe is kept for the process's life");
  resetScopeProbe();
  scopeAvailable({ env, systemdRun: systemdRunOnPath(env.PATH) });
  assert.equal(runs().length, 2);

  // A failure is retried after the retry window, so a manager that was briefly busy does not stick as unusable.
  const failing = binSetup({ fail: "Failed to connect to bus" });
  resetScopeProbe();
  let now = 1_000_000;
  const first = scopeAvailable({ env: failing.env, systemdRun: systemdRunOnPath(failing.env.PATH), now: () => now });
  assert.equal(first.ok, false);
  assert.equal(scopeAvailable({ env: failing.env, systemdRun: systemdRunOnPath(failing.env.PATH), now: () => now + 1000 }).ok, false);
  assert.equal(failing.runs().length, 1, "the failure is cached for a minute");
  now += 61_000;
  scopeAvailable({ env: failing.env, systemdRun: systemdRunOnPath(failing.env.PATH), now: () => now });
  assert.equal(failing.runs().length, 2, "the probe is retried once the window passed");
});
