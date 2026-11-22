import assert from "node:assert/strict";
import { test } from "node:test";
import { groupSubagents, runState } from "../web/lib/activity-rows.js";

const NOW = 1_800_000_000_000;
const agent = "claude#abc";
const sub = { id: "a1", type: "Explore" };
const run = (rows) => groupSubagents(rows).find(row => row.type === "subagent");
const agentCall = (time, resultTime) => ({
  id: "launch", type: "tool_call", agent, time, tool: "Agent", input: "{}",
  result: { output: '{"agentId":"a1","description":"scan","status":"completed"}', time: resultTime },
});

test("a foreground run whose Agent call completed at t=6 is done once its rows end at t=3", () => {
  const r = run([
    agentCall(1, 6),
    { id: "s", type: "start", agent, time: 2, subagent: sub },
    { id: "t", type: "tool_call", agent, time: 3, tool: "Read", input: "{}", subagent: sub },
  ]);
  assert.equal(r.done, true);
  assert.equal(runState(r, NOW), "done");
});

test("a tool row that arrives after the stop with an earlier timestamp leaves the run done", () => {
  const r = run([
    { id: "s", type: "start", agent, time: 2, subagent: sub },
    { id: "x", type: "stop", agent, time: 5, subagent: sub },
    { id: "t", type: "tool_call", agent, time: 4, tool: "Bash", input: "{}", subagent: sub },
  ]);
  assert.equal(r.done, true);
});
