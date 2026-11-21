import assert from "node:assert/strict";
import { test } from "node:test";
import { groupSubagents } from "../web/lib/activity-rows.js";
import { subagentState } from "../web/lib/subagent-state.js";

const NOW = 1_800_000_000_000;
const sec = (ms) => (NOW - ms) / 1000;
const run = (rows) => groupSubagents(rows).find(row => row.type === "subagent");
const event = (type, time, extra = {}) => ({ id: type + time, type, agent: "claude#abc", time, subagent: { id: "r1", type: "Explore" }, ...extra });

test("a started run with recent activity and no stop is running", () => {
  const r = run([event("start", sec(120_000)), event("tool_call", sec(30_000), { tool: "Read", input: "{}" })]);
  assert.equal(subagentState(r, NOW), "running");
});

test("a run that saw a stop is finished, however old", () => {
  const r = run([event("start", sec(3_600_000)), event("stop", sec(3_500_000))]);
  assert.equal(subagentState(r, NOW), "finished");
});

test("a run with no stop and no activity for over 10 min is stale", () => {
  const r = run([event("start", sec(900_000)), event("tool_call", sec(601_000), { tool: "Bash", input: "{}" })]);
  assert.equal(subagentState(r, NOW), "stale");
});

test("a later row refreshes a run's activity time", () => {
  const r = run([event("start", sec(900_000)), event("tool_call", sec(60_000), { tool: "Bash", input: "{}" })]);
  assert.equal(subagentState(r, NOW), "running");
});
