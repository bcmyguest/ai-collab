import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { watchTaskFinishes } from "../runner/task-wake.mjs";
import { loadSchedules } from "../runner/schedules.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const store = (file, statuses) => writeFileSync(file, JSON.stringify({ v: 1, tasks: Object.entries(statuses).map(([id, status]) => ({ id, title: id, status, blockers: [], progress: [], created: 1, updated: 1 })) }));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a task moving to done or blocked wakes the schedule once; a refused wake is retried", async (t) => {
  const file = path.join(tempDir(t, "task-wake-"), "p.json");
  store(file, { a: "building", b: "open", c: "done" });
  const calls = [];
  let accept = false;
  const stop = watchTaskFinishes({ file, everyMs: 20, wake: (ids) => { calls.push([...ids]); return accept; } });
  t.after(stop);
  await wait(60);
  assert.deepEqual(calls, [], "tasks already done at start do not wake");
  store(file, { a: "done", b: "blocked", c: "done" });
  await wait(60);
  assert.ok(calls.length >= 2, "a refused wake (the PM is still running) is retried");
  assert.deepEqual(calls[0].sort(), ["a", "b"]);
  accept = true;
  await wait(60);
  const after = calls.length;
  await wait(80);
  assert.equal(calls.length, after, "once a wake starts, it stops");
  store(file, { a: "done", b: "open", c: "done" });
  await wait(60);
  assert.equal(calls.length, after, "moving away from done does not wake");
});

test("schedules.json accepts wakeOnTasks as a project name", (t) => {
  const dir = tempDir(t, "task-wake-sched-");
  const file = path.join(dir, "schedules.json");
  writeFileSync(file, JSON.stringify([
    { name: "pm", everyMinutes: 30, cwd: dir, command: ["true"], wakeOnTasks: "ai-collab" },
    { name: "bad", everyMinutes: 30, cwd: dir, command: ["true"], wakeOnTasks: "../x" },
  ]));
  const { entries, errors } = loadSchedules({ AI_COLLAB_SCHEDULES: file });
  assert.equal(entries[0].wakeOnTasks, "ai-collab");
  assert.equal(entries.length, 1);
  assert.match(errors[0], /wakeOnTasks/);
});
