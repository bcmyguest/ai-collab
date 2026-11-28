// A native subagent run's transcript as a session's chat (hash subagent=<run id>), and the child a spawn_agent row started.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSelection, selectionHash } from "../web/lib/selection.js";
import { activityRows, groupSubagents, spawnedSession } from "../web/lib/activity-rows.js";
import { subagentThread } from "../web/lib/chat-turns.js";

const session = "claude#28d7fa48c0ffee01";

test("a session hash keeps the subagent whose transcript is the chat, beside any panel tab", () => {
  const hash = selectionHash({ project: "demo", level: "session", harness: "claude", session, subagent: "a1b2-c3" });
  assert.equal(hash, "project=demo&level=session&harness=claude&session=claude%2328d7fa48c0ffee01&subagent=a1b2-c3");
  assert.deepEqual(parseSelection(hash), { project: "demo", level: "session", harness: "claude", session, tab: "activity", run: "", subagent: "a1b2-c3" });
  const panel = parseSelection(selectionHash({ project: "demo", level: "session", harness: "claude", session, tab: "subagents", run: "r9", subagent: "a1b2-c3" }));
  assert.equal(panel.tab, "subagents");
  assert.equal(panel.run, "r9");
  assert.equal(panel.subagent, "a1b2-c3");
});

test("subagent is dropped without a session, outside the session level, or when it is not a run id", () => {
  assert.equal("subagent" in parseSelection("project=demo&level=session&subagent=a1"), false);
  assert.equal("subagent" in parseSelection("project=demo&level=project&subagent=a1"), false);
  assert.equal("subagent" in parseSelection(`level=session&session=${encodeURIComponent(session)}&subagent=${encodeURIComponent("a b<")}`), false);
  assert.equal(selectionHash({ project: "demo", level: "thread", thread: "th_00000000000000a1", subagent: "a1" }), "project=demo&level=thread&thread=th_00000000000000a1");
  assert.equal(selectionHash({ project: "demo", level: "session", session, subagent: "" }).includes("subagent"), false);
});

test("spawnedSession reads the child address from spawn_agent's result under any MCP prefix", () => {
  const output = JSON.stringify({ status: "started", session: "codex#799837ddad2d5d4b", harness: "codex" });
  assert.equal(spawnedSession({ type: "tool_result", tool: "mcp__plugin_ai-collab_ai-collab__spawn_agent", output }), "codex#799837ddad2d5d4b");
  assert.equal(spawnedSession({ type: "tool_call", tool: "spawn_agent", result: { output } }), "codex#799837ddad2d5d4b");
  // An MCP content array keeps the result JSON as an escaped string.
  assert.equal(spawnedSession({ type: "tool_result", tool: "ai-collab.spawn_agent", output: JSON.stringify([{ type: "text", text: output }]) }), "codex#799837ddad2d5d4b");
  assert.equal(spawnedSession({ type: "tool_result", tool: "Bash", output }), "");
  assert.equal(spawnedSession({ type: "tool_result", tool: "spawn_agent", output: "spawn_agent needs the ai-collab runner" }), "");
});

test("subagentThread lays a run's rows out as chat entries, its tool uses grouped between texts", () => {
  const agent = { id: "run1", type: "Explore" };
  const items = [
    { id: "1", type: "start", input: "subagent started · Explore", agent: session, time: 1, subagent: agent },
    { id: "2", type: "tool_call", tool: "Grep", callId: "g1", input: '{"pattern":"radius"}', agent: session, time: 2, subagent: agent },
    { id: "3", type: "tool_result", tool: "Grep", callId: "g1", output: "hit", agent: session, time: 3, subagent: agent },
    { id: "4", type: "text", output: "Found it.", agent: session, time: 4, subagent: agent },
    { id: "5", type: "stop", input: "subagent finished", output: "Done.", agent: session, time: 5, subagent: agent },
  ];
  const [run] = groupSubagents(activityRows(items)).filter(row => row.type === "subagent");
  const entries = subagentThread(run);
  assert.deepEqual(entries.map(entry => entry.activity.type), ["start", "group", "text", "stop"]);
  assert.equal(entries[1].activity.live, false);
});
