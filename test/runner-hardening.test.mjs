import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDurable } from "../runner/durable.mjs";
import { createRunner } from "../runner/runner.mjs";
import { listenControl, route } from "../runner/control.ts";
import { loadSchedules, registerSchedules, runCommand } from "../runner/schedules.ts";
import { acquireLock } from "../runner/lock.ts";
import { tempDir } from "./helpers/tmp.mjs";

const tmp = () => tempDir({ after }, "ai-collab-harden-");
const dbFile = () => path.join(tmp(), "runner.db");
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const node = (code, ...args) => [process.execPath, "-e", code, ...args];
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function waitFor(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(10);
  }
}

// A process that is gone, or a zombie waiting for its parent to reap it.
function isDead(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z";
  } catch {
    return true;
  }
}

test("a timeout kills the whole process group, not only the direct child", async () => {
  const cwd = tmp();
  const pidFile = path.join(cwd, "grandchild.pid");
  const code = `
    const { spawn } = require("child_process");
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    require("fs").writeFileSync(process.argv[1], String(grandchild.pid));
    setInterval(() => {}, 1000);`;
  const out = await runCommand(node(code, pidFile), { cwd, timeoutMs: 1000, graceMs: 200 });
  assert.equal(out.timedOut, true);
  const pid = Number(readFileSync(pidFile, "utf8"));
  await waitFor(() => isDead(pid));
});

test("a command that ignores SIGTERM is killed with SIGKILL after the grace period", async () => {
  const started = Date.now();
  const out = await runCommand(node("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"), { cwd: tmp(), timeoutMs: 200, graceMs: 200 });
  assert.equal(out.timedOut, true);
  assert.equal(out.ok, false);
  assert.equal(out.signal, "SIGKILL");
  assert.ok(Date.now() - started < 5000);
});

test("a command reads stdin as closed, so it cannot block on it", async () => {
  const out = await runCommand(node("process.stdin.on('end', () => console.log('eof')); process.stdin.resume()"), { cwd: tmp(), timeoutMs: 5000 });
  assert.equal(out.ok, true);
  assert.match(out.tail, /eof/);
});

test("a command killed by a signal is reported as that signal, not as a timeout", async () => {
  const out = await runCommand(node("process.kill(process.pid, 'SIGKILL')"), { cwd: tmp(), timeoutMs: 5000 });
  assert.deepEqual([out.ok, out.exitCode, out.signal, out.timedOut], [false, null, "SIGKILL", false]);
});

test("aborting a command kills its group and rejects with the abort reason", async () => {
  const controller = new AbortController();
  const promise = runCommand(node("setInterval(() => {}, 1000)"), { cwd: tmp(), timeoutMs: 60_000, signal: controller.signal, graceMs: 200 });
  setTimeout(() => controller.abort(new Error("stop requested")), 100);
  await assert.rejects(promise, /stop requested/);
});

test("loadSchedules reports unreadable, non-JSON and non-array files without throwing", () => {
  const dir = tmp();
  const file = path.join(dir, "schedules.json");
  writeFileSync(file, "{not json");
  let loaded = loadSchedules({ AI_COLLAB_SCHEDULES: file });
  assert.deepEqual(loaded.entries, []);
  assert.match(loaded.errors[0], /is not valid JSON/);

  writeFileSync(file, JSON.stringify({ name: "pm" }));
  loaded = loadSchedules({ AI_COLLAB_SCHEDULES: file });
  assert.match(loaded.errors[0], /must hold a JSON array/);
});

test("loadSchedules keeps the valid entries and reports each invalid one", () => {
  const dir = tmp();
  const file = path.join(dir, "schedules.json");
  const good = { name: "pm", everyMinutes: 30, cwd: dir, command: ["x"] };
  const bad = [
    { name: "missing-dir", everyMinutes: 30, cwd: path.join(dir, "nope"), command: ["x"] },
    { name: "too-long", everyMinutes: 525_601, cwd: dir, command: ["x"] },
    { name: "timeout-too-long", everyMinutes: 1, cwd: dir, command: ["x"], timeoutSec: 60 },
  ];
  writeFileSync(file, JSON.stringify([good, ...bad]));
  const { entries, errors } = loadSchedules({ AI_COLLAB_SCHEDULES: file });
  assert.deepEqual(entries.map((e) => e.name), ["pm"]);
  assert.equal(errors.length, 3);
  assert.match(errors[0], /is not a directory/);
  assert.match(errors[1], /everyMinutes must be an integer/);
  assert.match(errors[2], /timeoutSec must be shorter than everyMinutes/);
});

test("a missed tick within the grace of the next boundary waits for that boundary", async () => {
  let clock = 1_790_000; // 10 s before the 1_800_000 boundary of a 60 s schedule
  const log = openDurable(":memory:", { now: () => clock });
  log.scheduled("beat", { everyMs: 60_000 }, async () => "ran");
  log.startSchedules();
  assert.equal(log.status(`beat@${iso(1_740_000)}`), null);
  clock = 1_800_000;
  log.startSchedules();
  await log.result(`beat@${iso(1_800_000)}`);
  assert.equal(log.status(`beat@${iso(1_800_000)}`).status, "SUCCESS");
  await log.close();
});

test("a tick whose scheduled time is under an edited interval after the last run is skipped", async () => {
  const file = dbFile();
  let clock = 1_200_000;
  const first = openDurable(file, { now: () => clock });
  first.scheduled("beat", { everyMs: 60_000 }, async () => "old");
  first.startSchedules();
  await first.result(`beat@${iso(1_200_000)}`);
  await first.close();

  const second = openDurable(file, { now: () => 1_290_000 });
  second.scheduled("beat", { everyMs: 90_000 }, async () => "new");
  second.startSchedules();
  const row = second.status(`beat@${iso(1_260_000)}`);
  assert.equal(row.status, "SKIPPED");
  assert.match(row.output.skipped, /interval changed/);
  // The card still shows the run before the skip, not the skipped tick's status.
  assert.deepEqual([second.schedules()[0].last.id, second.schedules()[0].last.status], [`beat@${iso(1_200_000)}`, "SUCCESS"]);
  await second.close();
});

test("a manual run gets its own id, is rate-limited, logs its caller, and is skipped while the last one runs", async () => {
  const clock = { at: 5_000_000 };
  const durable = openDurable(":memory:", { now: () => clock.at });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  durable.scheduled("pm", { everyMs: 60_000 }, async () => { await gate; return "done"; });
  const logs = [];
  const runner = createRunner({ projects: [], adapters: new Map(), durable, env: {}, watch: false, now: () => clock.at, log: (m) => logs.push(m) });

  const first = await runner.runSchedule("pm", "test-cli");
  assert.equal(first.status, "started");
  assert.match(first.id, /^pm@manual@[0-9a-f-]{36}$/);

  clock.at += 11_000;
  const second = await runner.runSchedule("pm", "test-cli");
  assert.equal(second.status, "skipped");
  assert.equal(durable.status(second.id).status, "SKIPPED");
  assert.throws(() => runner.runSchedule("pm", "test-cli"), { status: 429 });
  assert.match(logs.join("\n"), /by test-cli/);

  release();
  await durable.result(first.id);
  await durable.close();
});

test("the schedules view carries the config errors", async () => {
  const durable = openDurable(":memory:");
  const runner = createRunner({ projects: [], adapters: new Map(), durable, env: {}, watch: false, scheduleErrors: ["schedules.json entry 0: cwd is wrong"] });
  assert.deepEqual(await runner.schedules(), { schedules: [], configError: ["schedules.json entry 0: cwd is wrong"] });
  return durable.close();
});

test("a route run passes the sanitized caller to the runner", async () => {
  const seen = [];
  const runner = {
    schedules: () => ({ schedules: [], configError: [] }),
    runSchedule: (name, caller) => { seen.push([name, caller]); return { id: "x", status: "started" }; },
  };
  const [status] = await route(runner, "POST", new URL("http://runner.invalid/v1/schedules/pm/run?caller=cli%20user%3Bx"), {});
  assert.equal(status, 202);
  assert.deepEqual(seen, [["pm", "cliuserx"]]);
});

test("POST /v1/sessions/:harness/:label/compact reaches the runner's compact", async () => {
  const seen = [];
  const runner = { compact: async (address) => { seen.push(address); return { status: "succeeded", detail: "Compacted the session in place. 90000 → 20000 tokens." }; } };
  const url = new URL("http://runner.invalid/v1/sessions/claude/0123456789abcdef/compact");
  const [status, value] = await route(runner, "POST", url, {});
  assert.equal(status, 200);
  assert.deepEqual(seen, ["claude#0123456789abcdef"]);
  assert.equal(value.status, "succeeded");
});

test("boot leaves scheduled ticks out of its recovered list and does not wait on them", async () => {
  const file = dbFile();
  const define = (log) => log.scheduled("stuck", { everyMs: 60_000, firstStep: "command" }, async (scheduled, actual, wf) => wf.step("command", () => new Promise((_, reject) => {
    wf.signal.addEventListener("abort", () => reject(wf.signal.reason));
  })));
  const first = openDurable(file);
  define(first);
  const { id } = first.runScheduled("stuck");
  await first.close();

  const second = openDurable(file);
  define(second);
  const runner = createRunner({ projects: [], adapters: new Map(), durable: second, env: {}, watch: false });
  const started = Date.now();
  assert.deepEqual(await runner.boot(), []);
  assert.ok(Date.now() - started < 1000);
  assert.equal(second.status(id).status, "PENDING"); // recovered and running
  await second.close();
});

test("the lock admits one live holder and replaces a pid whose process is gone", () => {
  const file = path.join(tmp(), "runner.lock");
  const release = acquireLock(file);
  assert.throws(() => acquireLock(file), /another runner holds/);
  release();
  assert.equal(existsSync(file), false);

  const exited = spawnSync(process.execPath, ["-e", ""]);
  writeFileSync(file, `${exited.pid}\n`);
  const replaced = acquireLock(file);
  assert.equal(readFileSync(file, "utf8").trim(), String(process.pid));
  replaced();
});

test("the control socket is 0600 in a 0700 directory", async () => {
  const dir = path.join(tmp(), "run");
  const socket = path.join(dir, "runner.sock");
  const control = await listenControl({ schedules: () => ({}), runSchedule: () => ({}) }, socket);
  try {
    assert.equal(statSync(socket).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  } finally {
    await control.close();
  }
});

test("a runner whose socket bind fails starts no schedule, leaves no lock, and exits non-zero", async () => {
  const dir = tmp();
  const socket = path.join(dir, "live.sock");
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(socket, resolve));
  const marker = path.join(dir, "ran");
  const schedules = path.join(dir, "schedules.json");
  const command = node("require('fs').writeFileSync(process.argv[1], 'x')", marker);
  writeFileSync(schedules, JSON.stringify([{ name: "pm", everyMinutes: 30, cwd: dir, command, timeoutSec: 60 }]));
  mkdirSync(path.join(dir, "state"), { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    AI_COLLAB_RUNNER_DB: path.join(dir, "state", "runner.db"),
    AI_COLLAB_RUNNER_SOCKET: socket,
    AI_COLLAB_SCHEDULES: schedules,
  };
  const result = await new Promise((resolve) => {
    execFile(process.execPath, [path.join(REPO, "runner", "main.mjs")], { env, timeout: 20_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stderr });
    });
  });
  holder.close();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /another runner listens/);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(path.join(dir, "state", "runner.lock")), false);
});
