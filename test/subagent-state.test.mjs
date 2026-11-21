import assert from "node:assert/strict";
import { test } from "node:test";
import { runState } from "../web/lib/activity-rows.js";
import { sessionState } from "../web/lib/session-state.js";

const NOW = 1_800_000_000_000;
const ago = (ms) => (NOW - ms) / 1000;

test("a session whose subagent still runs is working, not idle", () => {
  const run = { done: false, time: ago(300_000), lastTime: ago(30_000) };
  assert.equal(sessionState({ online: true, lastActivityAt: NOW - 300_000, subagents: [run] }, NOW), "working");
  assert.equal(sessionState({ online: true, lastActivityAt: NOW - 300_000, subagents: [{ ...run, done: true }] }, NOW), "idle");
});

test("a subagent inside one long tool call stays running up to 15 min", () => {
  const run = { done: false, time: ago(600_000), lastTime: ago(300_000) };
  assert.equal(runState(run, NOW), "idle");
  assert.equal(runState({ ...run, open: true }, NOW), "running");
  assert.equal(runState({ ...run, open: true, lastTime: ago(16 * 60_000) }, NOW), "idle");
});
