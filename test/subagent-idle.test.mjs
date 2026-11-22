import assert from "node:assert/strict";
import { test } from "node:test";
import { runningCount, splitIdleRuns, IDLE_HIDE_MS } from "../web/lib/subagent-state.js";

const NOW = 1_800_000_000_000;
const sec = (ms) => (NOW - ms) / 1000;
const run = (id, lastAgoMs, extra = {}) => ({ id, run: id, time: sec(lastAgoMs), lastTime: sec(lastAgoMs), done: false, open: false, ...extra });

test("the idle threshold is 30 minutes", () => {
  assert.equal(IDLE_HIDE_MS, 30 * 60_000);
});

test("running runs count; a run without an open call is running only within 2 min", () => {
  const runs = [run("a", 60_000), run("b", 3_600_000), run("c", 90_000)];
  assert.equal(runningCount(runs, NOW), 2);
});

test("runs idle over 30 min are hidden, shorter idle runs stay visible", () => {
  const runs = [run("fresh", 60_000), run("idle-10m", 600_000), run("idle-45m", 2_700_000)];
  const { shown, idle } = splitIdleRuns(runs, NOW);
  assert.deepEqual(shown.map(r => r.id), ["fresh", "idle-10m"]);
  assert.deepEqual(idle.map(r => r.id), ["idle-45m"]);
});

test("a run with an open tool call inside the 15 min window stays visible and running", () => {
  const open = run("long-build", 600_000, { open: true });
  const { shown, idle } = splitIdleRuns([open], NOW);
  assert.deepEqual(shown.map(r => r.id), ["long-build"]);
  assert.equal(idle.length, 0);
  assert.equal(runningCount([open], NOW), 1);
});
