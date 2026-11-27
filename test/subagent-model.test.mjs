// A subagent's model: the Agent call's model, another harness's own event model, else the Claude parent's, marked inherited.
import assert from "node:assert/strict";
import { test } from "node:test";
import { groupSubagents, subagentModel } from "../web/lib/activity-rows.js";
import { activityEvents, buildActivity } from "../lib/activity.ts";
import { childRuns } from "../web/lib/child-subagents.js";

const lead = "claude#0000000000000001";

test("the Agent call's model names the run; without one a Claude run inherits the parent's", () => {
  const runs = groupSubagents([
    { agent: lead, type: "tool_result", tool: "Agent", time: 1, input: '{"subagent_type":"Explore","model":"sonnet"}', output: '{"agentId":"a1","status":"async_launched"}' },
    { agent: lead, type: "tool_result", tool: "Agent", time: 1, input: { subagent_type: "Plan" }, output: '{"agentId":"a2"}' },
    { agent: lead, type: "tool_call", tool: "Read", time: 2, subagent: { id: "a1", type: "Explore" } },
    { agent: lead, type: "tool_call", tool: "Read", time: 2, subagent: { id: "a2", type: "Plan" } },
  ]).filter(row => row.type === "subagent");
  const parent = { id: lead, peer: "claude", model: "opus-5-5" };
  assert.deepEqual(runs.map(run => subagentModel(run, parent)), ["sonnet", "opus-5-5 · inherited"]);
  assert.equal(subagentModel(runs[1], undefined), "");
});

test("a child session's entry carries its own model and never inherits the parent's", () => {
  const parent = { id: lead, harness: "claude", model: "opus-5-5" };
  const [withModel] = childRuns([parent, { id: "codex#0000000000000003", parent: lead, harness: "codex", model: "gpt-5.5-codex" }]).get(lead);
  assert.equal(subagentModel(withModel, parent), "gpt-5.5-codex");
  const [without] = childRuns([parent, { id: "codex#0000000000000004", parent: lead, harness: "codex" }]).get(lead);
  assert.equal(subagentModel(without, { ...parent, peer: "claude" }), "");
});

test("another harness's subagent events carry their own model; a codex run without one shows none", () => {
  const [event] = activityEvents("codex", "pretooluse", { tool_name: "shell", agent_id: "c1", agent_type: "worker", model: "gpt-5.5-codex" });
  assert.deepEqual(event.agent, { id: "c1", type: "worker", model: "gpt-5.5-codex" });
  assert.deepEqual(activityEvents("claude", "pretooluse", { tool_name: "Read", agent_id: "c2", agent_type: "Explore", model: "x" })[0].agent, { id: "c2", type: "Explore" });
  const wire = JSON.parse(buildActivity({ peer: "codex", session: "0000000000000002" }, "codex", event).message);
  assert.deepEqual(wire.agent, { id: "c1", type: "worker", model: "gpt-5.5-codex" });
  const [run] = groupSubagents([{ agent: "codex#0000000000000002", type: "tool_call", tool: "shell", time: 1, subagent: { id: "c3", type: "worker" } }]);
  assert.equal(subagentModel(run, { id: "codex#0000000000000002", peer: "codex", model: "gpt-5.5" }), "");
  const [own] = groupSubagents([{ agent: "codex#0000000000000002", type: "tool_call", tool: "shell", time: 1, subagent: { id: "c4", type: "worker", model: "gpt-5.5-mini" } }]);
  assert.equal(subagentModel(own, {}), "gpt-5.5-mini");
});
