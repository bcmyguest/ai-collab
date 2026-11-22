import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadProjects, sessionLabel } from "../lib/config.mjs";
import { resetScopeProbe, scopeAvailable, systemdRunOnPath } from "../lib/scope.mjs";
import { createUi } from "../web/server/ui.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const base = "http://127.0.0.1:8795";
const ID = "77777777-2222-4333-8444-555555555555";

// A stand-in for systemd-run: it records its argv, then runs what follows `--` with the caller's stdio and exit code,
// which is how the real one behaves in a scope (it execs the payload). FAKE_RECORD names the record file.
const SYSTEMD_RUN = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ argv, env: { AI_COLLAB_SCOPE: process.env.AI_COLLAB_SCOPE || "" } }) + "\\n");
const at = argv.indexOf("--");
if (at < 0) process.exit(64); // the real systemd-run refuses a command without the separator
const [file, ...args] = argv.slice(at + 1);
const run = spawnSync(file, args, { stdio: "inherit" });
process.exit(run.status === null ? 1 : run.status);
`;

// A harness that prints the session id its CLI prints, records its argv and cwd, and leaves its PID in $FAKE_HOLD.
const HARNESS = `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_RECORD + ".seen", JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid }) + "\\n");
console.log("Started background session ${ID}");
if (process.env.FAKE_HOLD) fs.writeFileSync(process.env.FAKE_HOLD, String(process.pid));
setTimeout(() => {}, process.env.FAKE_HOLD ? 60000 : 0);
`;

// The env a UI running as a systemd user unit has: INVOCATION_ID set and a user manager socket to reach.
function unitEnv(files) {
  const runtime = path.join(files.home, "run");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(path.join(runtime, "bus"), "");
  return {
    HOME: files.home, PATH: [files.bin, path.dirname(process.execPath)].join(path.delimiter), FAKE_RECORD: files.record,
    XDG_RUNTIME_DIR: runtime, INVOCATION_ID: "0".repeat(32), CODEX_HOME: path.join(files.home, ".codex"),
    AI_COLLAB_STATE_DIR: path.join(files.home, "state"), FAKE_HOLD: files.hold,
  };
}

// A directory layout for one test: a bin with an optional systemd-run and a fake claude, a root, and a record file.
function setupFiles({ systemdRun = true } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-scope-ui-"));
  const bin = path.join(home, "bin");
  const root = path.join(home, "project");
  const record = path.join(home, "record.jsonl");
  const hold = path.join(home, "hold.pid");
  for (const dir of [bin, root, path.join(home, ".config", "ai-collab"), path.join(home, "state")]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(bin, "claude"), HARNESS);
  chmodSync(path.join(bin, "claude"), 0o755);
  if (systemdRun) {
    writeFileSync(path.join(bin, "systemd-run"), SYSTEMD_RUN);
    chmodSync(path.join(bin, "systemd-run"), 0o755);
  }
  return { home, bin, root, record, hold };
}

async function setupUi(t, options) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const files = setupFiles(options);
  writeFileSync(path.join(files.home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root: files.root, project: "demo", url: fake.url, peers: "claude" }]));
  const env = unitEnv(files);
  resetScopeProbe();
  const ui = createUi({ projects: loadProjects(env, { host: "operator" }), env });
  t.after(() => ui.close());
  const post = (body) => ui.handle(new Request(`${base}/api/start`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), "start");
  return { ui, post, env, ...files };
}

const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const runs = (record) => lines(record);
const seen = (record) => lines(record + ".seen");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function eventually(check, ms = 10000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await delay(20);
  }
}

test("a UI start puts the harness in its own scope, with the same argv, folder and env", async (t) => {
  const { post, record } = await setupUi(t);
  const res = await post({ project: "demo", harness: "claude", prompt: "run the tests" });
  assert.equal(res.status, 201);
  const result = await res.json();
  // The API still answers from the harness's own output.
  assert.equal(result.status, "started");
  assert.equal(result.session, "claude#" + sessionLabel(ID));

  const start = runs(record).find((run) => run.argv.some((arg) => arg.startsWith("--unit=ai-collab-session-claude-")));
  assert.ok(start, "the harness is launched through systemd-run");
  assert.deepEqual(start.argv.slice(0, 4), ["--user", "--scope", "--quiet", "--collect"]);
  const at = start.argv.indexOf("--");
  assert.ok(start.argv[at + 1].endsWith("claude"), "the harness itself is the scoped command");
  assert.deepEqual(start.argv.slice(at + 2), ["--bg", "run the tests"], "the harness argv is unchanged inside the scope");
  await eventually(() => seen(record).length > 0);
  assert.match(seen(record)[0].cwd, /project$/, "the harness still runs in the project root");
  // AI_COLLAB_SCOPE is this process's own switch, never the harness's business.
  assert.equal(start.env.AI_COLLAB_SCOPE, "", "the switch is not passed to the harness's environment");
});

test("without systemd-run a UI start spawns exactly as before", async (t) => {
  const { post, record } = await setupUi(t, { systemdRun: false });
  const result = await (await post({ project: "demo", harness: "claude", prompt: "hello" })).json();
  assert.equal(result.status, "started");
  assert.deepEqual(runs(record), [], "nothing wraps the harness");
  assert.deepEqual(seen(record).map((run) => run.argv), [["--bg", "hello"]], "the harness ran directly");
});

test("AI_COLLAB_SCOPE=off turns the scope off and the start still works", async (t) => {
  const { post, record, env } = await setupUi(t);
  env.AI_COLLAB_SCOPE = "off";
  resetScopeProbe();
  const result = await (await post({ project: "demo", harness: "claude", prompt: "still starts" })).json();
  assert.equal(result.status, "started");
  assert.deepEqual(runs(record), [], "systemd-run is not called");
  assert.deepEqual(seen(record).map((run) => run.argv), [["--bg", "still starts"]]);
});

// The property a fake cannot show. A transient unit stands in for the UI's own unit: it starts a session with
// startSession, exactly as the UI does, and then the unit is stopped, which kills everything left in its cgroup.
test("a session a UI-shaped unit starts is in another cgroup and outlives that unit being stopped", async (t) => {
  resetScopeProbe();
  const env = { ...process.env, AI_COLLAB_SCOPE: "on" };
  if (!scopeAvailable({ env }).ok) {
    t.skip("systemd-run cannot make a scope here");
    return;
  }
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  // The fake claude only: this test needs the real systemd-run for both the stand-in unit and the scope.
  const files = setupFiles({ systemdRun: false });
  writeFileSync(path.join(files.home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root: files.root, project: "demo", url: fake.url, peers: "claude" }]));
  const realSystemdRun = systemdRunOnPath(env.PATH);
  // A real user manager is needed here, so this env keeps the host's own session bus. A transient *service* does not
  // inherit the caller's environment, so every variable the driver needs goes on the command line.
  const childEnvVars = {
    HOME: files.home, PATH: [files.bin, env.PATH].join(path.delimiter),
    FAKE_RECORD: files.record, FAKE_HOLD: files.hold, CODEX_HOME: path.join(files.home, ".codex"),
    AI_COLLAB_STATE_DIR: path.join(files.home, "state"), AI_COLLAB_SCOPE: "on",
  };
  const setenv = Object.entries(childEnvVars).flatMap(([key, value]) => [`--setenv=${key}=${value}`]);
  const unit = `ai-collab-test-ui-${process.pid}-${Date.now()}`;
  const driver = path.join(files.home, "ui.mjs");
  writeFileSync(driver, `
import { writeFileSync } from "node:fs";
import { loadProjects } from ${JSON.stringify(new URL("../lib/config.mjs", import.meta.url).href)};
import { startSession } from ${JSON.stringify(new URL("../lib/start.mjs", import.meta.url).href)};
const env = process.env;
const [cfg] = loadProjects(env, { host: "operator" });
const out = await startSession(cfg, { harness: "claude", prompt: "survive", env });
writeFileSync(${JSON.stringify(files.hold)} + ".started", JSON.stringify(out));
setTimeout(() => {}, 120000);
`);
  // A transient service is the UI's unit: startSession runs inside it, so its scope is a sibling of that cgroup.
  const started = spawn(realSystemdRun, ["--user", "--quiet", "--unit", unit, ...setenv, "--", process.execPath, driver], {
    cwd: files.home, stdio: "ignore", detached: true,
  });
  started.unref();
  t.after(() => { try { execFileSync("systemctl", ["--user", "stop", unit], { env, stdio: "ignore" }); } catch { /* gone */ } });
  await eventually(() => existsSync(files.hold) && existsSync(files.hold + ".started"), 20000);
  const pid = Number(readFileSync(files.hold, "utf8"));
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });
  assert.equal(JSON.parse(readFileSync(files.hold + ".started", "utf8")).status, "started");
  const sessionCgroup = readFileSync(`/proc/${pid}/cgroup`, "utf8");
  assert.match(sessionCgroup, /ai-collab-session-claude-/, "the session runs in its own transient scope");
  assert.doesNotMatch(sessionCgroup, new RegExp(unit), "the session is not in the UI unit's cgroup");
  // The restart: stopping the unit kills its cgroup. The session is outside it, so it keeps running.
  execFileSync("systemctl", ["--user", "stop", unit], { env, stdio: "ignore" });
  await delay(700);
  assert.equal(alive(pid), true, "the session outlives the UI's unit");
});
