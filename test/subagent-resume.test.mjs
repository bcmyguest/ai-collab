import assert from "node:assert/strict";
import { test } from "node:test";
import { activityRows, groupSubagents, runState } from "../web/lib/activity-rows.js";

const NOW = 1_800_000_000_000;
const sec = (ms) => (NOW - ms) / 1000;
const agent = "claude#abc";
const sub = { id: "r1", type: "Explore" };
const row = (type, time, extra = {}) => ({ id: type + time, type, agent, time, subagent: sub, ...extra });
const runOf = (items) => groupSubagents(activityRows(items)).find(r => r.type === "subagent");

test("a run resumed after its stop is running again on the next tool row", () => {
  const r = runOf([
    row("start", sec(900_000)),
    row("stop", sec(600_000)),
    row("tool_call", sec(30_000), { tool: "Read", input: "{}" }),
  ]);
  assert.equal(r.done, false);
  assert.equal(runState(r, NOW), "running");
});

test("a run stopped with no rows after it stays done", () => {
  const r = runOf([row("start", sec(900_000)), row("tool_call", sec(800_000), { tool: "Read", input: "{}" }), row("stop", sec(700_000))]);
  assert.equal(r.done, true);
  assert.equal(runState(r, NOW), "done");
});
