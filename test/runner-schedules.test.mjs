import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECT_PAUSED, setProjectPaused } from "../lib/project-pause.mjs";
import { openDurable } from "../runner/durable.mjs";
import { listenControl, route } from "../runner/control.mjs";
import { runnerRequest, runnerClient } from "../runner/client.mjs";
import { loadSchedules, registerSchedules, runCommand, schedulesPath, tickFn } from "../runner/schedules.mjs";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "ai-collab-sched-"));
const dbFile = () => path.join(tmp(), "runner.db");
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const node = (code) => [process.execPath, "-e", code];

async function waitFor(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(10);
  }
}

test("a start after downtime runs only the latest due tick, and each tick once", async () => {
  const file = dbFile();
  let clock = 600_000;
  const calls = [];
  const register = (log) => log.scheduled("beat", { everyMs: 60_000 }, async (scheduled, actual) => {
    calls.push([scheduled.getTime(), actual.getTime()]);
  });

  const first = openDurable(file, { now: () => clock });
  register(first);
  first.startSchedules();
  await first.result(`beat@${iso(600_000)}`);
  await first.close();

  clock = 1_040_000; // 17 min 20 s: the ticks at 11 to 17 min (except 17) were missed
  const second = openDurable(file, { now: () => clock });
  register(second);
  second.startSchedules();
  await second.result(`beat@${iso(1_020_000)}`);
  assert.deepEqual(calls, [[600_000, 600_000], [1_020_000, 1_040_000]]);
  assert.equal(second.status(`beat@${iso(660_000)}`), null);
  await second.close();

  const third = openDurable(file, { now: () => clock });
  register(third);
  third.startSchedules();
  await sleep(20);
  assert.equal(calls.length, 2);
  await third.close();
});

test("a tick that finds the previous run still going is recorded as skipped", async () => {
  const log = openDurable(":memory:");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let runs = 0;
  log.scheduled("slow", { everyMs: 20 }, async () => {
    runs += 1;
    await gate;
    return "done";
  });
  log.startSchedules();
  // The skip is in the run list, but it is not the schedule's last run: the real one still going keeps that place.
  await waitFor(() => log.scheduleRuns("slow").some((run) => run.output?.skipped));
  assert.equal(runs, 1);
  assert.equal(log.scheduleRuns("slow")[0].status, "SKIPPED");
  assert.notEqual(log.schedules()[0].last.status, "SKIPPED");
  release();
  await waitFor(() => runs >= 2);
  await log.close();
});

test("runScheduled starts a tick now under its own id", async () => {
  const log = openDurable(":memory:");
  log.scheduled("now", { everyMs: 60_000 }, async () => "ran");
  const { id, status } = log.runScheduled("now");
  assert.equal(status, "started");
  assert.equal(await log.result(id), "ran");
  assert.equal(log.schedules()[0].last.id, id);
  await log.close();
});

test("scheduled rejects a cron option, a non-integer interval and a duplicate name", async () => {
  const log = openDurable(":memory:");
  assert.throws(() => log.scheduled("a", { cron: "* * * * *" }, () => {}), /everyMs must be a positive integer/);
  log.scheduled("a", { everyMs: 1000 }, () => {});
  assert.throws(() => log.scheduled("a", { everyMs: 1000 }, () => {}), /already registered/);
  await log.close();
});

test("a scheduled command records its exit code and output tail", async () => {
  const log = openDurable(":memory:");
  registerSchedules(log, [{ name: "pm", everyMs: 60_000, cwd: tmp(), command: node("console.log('tick ran')"), timeoutMs: 10_000 }]);
  const { id, status } = log.runScheduled("pm");
  assert.equal(status, "started");
  const out = await log.result(id);
  assert.deepEqual([out.ok, out.exitCode, out.timedOut], [true, 0, false]);
  assert.match(out.tail, /tick ran/);
  assert.equal(log.status(id).status, "SUCCESS");
  await log.close();
});

test("a tick cut by a stop kills its command and is recorded as cut at recovery, not re-run", async () => {
  const file = dbFile();
  const cwd = tmp();
  const marker = path.join(cwd, "runs");
  // Each run appends one x to the marker, so a second run would show as a second x.
  const command = [process.execPath, "-e", "require('fs').appendFileSync(process.argv[1], 'x'); setTimeout(() => {}, 60000)", marker];
  const entry = { name: "pm", everyMs: 60_000, cwd, command, timeoutMs: 60_000 };
  const first = openDurable(file);
  registerSchedules(first, [entry]);
  const { id } = first.runScheduled("pm");
  await waitFor(() => existsSync(marker) && readFileSync(marker, "utf8") === "x");
  await first.close();

  const second = openDurable(file);
  registerSchedules(second, [entry]);
  assert.deepEqual(second.recover(), [id]);
  const out = await second.result(id);
  assert.equal(out.ok, false);
  assert.match(out.cut, /not re-run/);
  assert.equal(second.status(id).status, "SUCCESS");
  assert.equal(readFileSync(marker, "utf8"), "x");
  await second.close();
});

test("runCommand keeps the output tail, reports exit codes, timeouts and missing binaries", async () => {
  const cwd = tmp();
  const ok = await runCommand(node("console.log('x'.repeat(3000) + 'END')"), { cwd, timeoutMs: 10_000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.tail.length, 2000);
  assert.ok(ok.tail.endsWith("END\n"));

  const failed = await runCommand(node("process.exit(3)"), { cwd, timeoutMs: 10_000 });
  assert.deepEqual([failed.ok, failed.exitCode], [false, 3]);

  const slow = await runCommand(node("setTimeout(() => {}, 60000)"), { cwd, timeoutMs: 200 });
  assert.deepEqual([slow.ok, slow.timedOut], [false, true]);

  const missing = await runCommand(["/nonexistent/ai-collab-binary"], { cwd, timeoutMs: 1000 });
  assert.equal(missing.ok, false);
  assert.match(missing.tail, /ENOENT/);
});

test("loadSchedules reads AI_COLLAB_SCHEDULES, treats a missing file as none, and reports bad entries", () => {
  const dir = tmp();
  const file = path.join(dir, "schedules.json");
  assert.deepEqual(loadSchedules({ AI_COLLAB_SCHEDULES: file }), { entries: [], errors: [] });

  writeFileSync(file, JSON.stringify([{ name: "pm", everyMinutes: 30, cwd: dir, command: ["cursor-agent", "-p"], timeoutSec: 900 }]));
  assert.deepEqual(loadSchedules({ AI_COLLAB_SCHEDULES: file }), {
    entries: [{ name: "pm", everyMs: 1_800_000, cwd: dir, command: ["cursor-agent", "-p"], timeoutMs: 900_000 }],
    errors: [],
  });

  const bad = [
    { name: "pm", everyMinutes: 30, cwd: "relative", command: ["x"] },
    { name: "pm", everyMinutes: 30, cwd: dir, command: [] },
    { name: "pm", cron: "*/5 * * * *", cwd: dir, command: ["x"] },
    { name: "Bad Name", everyMinutes: 30, cwd: dir, command: ["x"] },
    { name: "pm", everyMinutes: 0, cwd: dir, command: ["x"] },
    { name: "pm", everyMinutes: 30, cwd: dir, command: ["x"], extra: 1 },
  ];
  for (const entry of bad) {
    writeFileSync(file, JSON.stringify([entry]));
    const { entries, errors } = loadSchedules({ AI_COLLAB_SCHEDULES: file });
    assert.deepEqual([entries.length, errors.length], [0, 1]);
    assert.match(errors[0], /schedules\.json entry 0/);
  }
  const twice = { name: "pm", everyMinutes: 30, cwd: dir, command: ["x"] };
  writeFileSync(file, JSON.stringify([twice, twice]));
  const { entries, errors } = loadSchedules({ AI_COLLAB_SCHEDULES: file });
  assert.equal(entries.length, 1);
  assert.match(errors[0], /appears twice/);
});

test("schedulesPath defaults to the ai-collab config directory", () => {
  const home = tmp();
  assert.equal(schedulesPath({ HOME: home }), path.join(home, ".config", "ai-collab", "schedules.json"));
  assert.equal(schedulesPath({ AI_COLLAB_SCHEDULES: "/x/s.json", HOME: home }), "/x/s.json");
});

test("GET /v1/schedules lists schedules and POST run starts one over the control socket", async () => {
  const runner = {
    schedules: () => ({ schedules: [{ name: "pm", nextRun: "2026-11-21T10:30:00.000Z", last: null }], configError: [] }),
    runSchedule: (name) => {
      if (name !== "pm") throw Object.assign(new Error("Unknown schedule"), { status: 404 });
      return { id: "pm@2026-11-21T10:00:00.000Z", status: "started" };
    },
  };
  const socket = path.join(tmp(), "runner.sock");
  const control = await listenControl(runner, socket);
  try {
    const client = runnerClient({ socket });
    const listed = await client.schedules();
    assert.equal(listed.status, 200);
    assert.equal(listed.body.schedules[0].name, "pm");
    assert.deepEqual(listed.body.configError, []);
    const started = await client.runSchedule("pm");
    assert.deepEqual([started.status, started.body.status], [202, "started"]);
    assert.equal((await client.runSchedule("nope")).status, 404);
    assert.equal((await runnerRequest("GET", "/v1/schedules/pm/run", undefined, { socket })).status, 405);
  } finally {
    await control.close();
  }
});

test("route rejects a GET on the run path", async () => {
  const runner = { schedules: () => [], runSchedule: () => ({}) };
  await assert.rejects(route(runner, "GET", new URL("http://runner.invalid/v1/schedules/pm/run"), {}), { status: 405 });
});

test("a paused project skips scheduled session starts and lets a scheduled resume run", async () => {
  const cwd = tmp();
  const stateDir = path.join(cwd, "state");
  const codex = path.join(cwd, "codex");
  writeFileSync(codex, "#!/bin/sh\necho ran\n", { mode: 0o700 });
  const project = { project: "demo", root: cwd, stateDir };
  const env = { AI_COLLAB_STATE_DIR: stateDir, AI_COLLAB_SCOPE: "off" };
  setProjectPaused(project, true);
  const tick = (command) => tickFn({ name: "beat", cwd, command, timeoutMs: 1000 }, { env, projects: [project] })(
    new Date(0), new Date(0), { step: (_name, run) => run() },
  );

  assert.equal((await tick([codex, "exec", "do work"])).tail, PROJECT_PAUSED);
  const resumed = await tick([codex, "exec", "resume", "existing-session", "continue work"]);
  assert.equal(resumed.ok, true);
  assert.match(resumed.tail, /ran/);
});
