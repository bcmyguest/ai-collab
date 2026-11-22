import assert from "node:assert/strict";
import { test } from "node:test";
import { activityRows, groupSubagents } from "../web/lib/activity-rows.js";
import { completionRows, liveRows, projectThread } from "../web/lib/project-feed.js";

const A = "claude#abc12345";
const B = "codex#def67890";
const row = (id, time, type, extra = {}) => ({ id, time, type, agent: A, ...extra });
const grouped = items => groupSubagents(activityRows(items));

const finished = [
  row("p1", 100, "prompt", { input: "Fix the flaky\nrunner test" }),
  row("c1", 101, "tool_call", { tool: "Bash", callId: "k1", input: '{"command":"ls"}' }),
  row("r1", 102, "tool_result", { tool: "Bash", callId: "k1", output: "ok" }),
  row("t1", 103, "text", { output: "Looking at it" }),
  row("t2", 106, "text", { output: "Done: fixed.\n\nDetails follow." }),
  row("s1", 107, "stop", { input: "turn ended" }),
];

test("a finished turn becomes one completion row named by the first line of its final message", () => {
  assert.deepEqual(completionRows(grouped(finished)), [
    { id: "done:s1", type: "completion", agent: A, time: 107, text: "Done: fixed." },
  ]);
});

test("a running turn has no completion row and a live row named by its prompt", () => {
  const items = finished.slice(0, 4);
  assert.deepEqual(completionRows(grouped(items)), []);
  assert.deepEqual(liveRows(grouped(items), 103_000 + 1000), []);
  const open = [...items, row("c2", 104, "tool_call", { tool: "Bash", callId: "k2", input: '{"command":"npm test"}' })];
  assert.deepEqual(liveRows(grouped(open), 105_000), [{ id: "live:" + A, type: "live", agent: A, summary: "Fix the flaky runner test" }]);
});

test("a session with a running subagent is live", () => {
  const run = { subagent: { id: "run1", type: "Explore" } };
  const items = [
    row("p1", 100, "prompt", { input: "Survey the repo" }),
    { ...row("c1", 101, "tool_call", { tool: "Grep", callId: "k1", input: '{"pattern":"x"}' }), ...run },
    { ...row("r1", 102, "tool_result", { tool: "Grep", callId: "k1", output: "" }), ...run },
  ];
  assert.deepEqual(liveRows(grouped(items), 103_000).map(item => item.agent), [A]);
});

test("completion rows from two sessions sort by time and keep their sessions", () => {
  const other = [
    { ...row("p2", 90, "prompt", { input: "Lint" }), agent: B },
    { ...row("t3", 95, "text", { output: "Lint clean" }), agent: B },
    { ...row("s2", 96, "stop", { input: "turn ended" }), agent: B },
  ];
  assert.deepEqual(completionRows(grouped([...finished, ...other])).map(item => [item.agent, item.text]), [
    [B, "Lint clean"],
    [A, "Done: fixed."],
  ]);
});

test("the project thread merges completion rows with chat messages by time", () => {
  const messages = [
    { id: "m1", time: 98, from: "operator", body: "status?" },
    { id: "m2", time: 120, from: A, body: "question" },
  ];
  const thread = projectThread(messages, grouped(finished));
  assert.deepEqual(thread.map(entry => entry.message?.id ?? entry.activity.id), ["m1", "done:s1", "m2"]);
});
