import assert from "node:assert/strict";
import { test } from "node:test";
import { activityRows, groupSubagents } from "../web/lib/activity-rows.js";
import { chatFlow, chatThread, groupLabel } from "../web/lib/chat-turns.js";

const A = "claude#abc12345";
const row = (id, time, type, extra = {}) => ({ id, time, type, agent: A, ...extra });
const use = (id, time, n, tool, input = '{"command":"ls"}') => [
  row("c" + id, time, "tool_call", { tool, callId: "k" + n, input }),
  row("r" + id, time + 1, "tool_result", { tool, callId: "k" + n, output: "ok" }),
];
const grouped = items => groupSubagents(activityRows(items));
const ids = thread => thread.map(item => item.message ? item.message.id : item.activity.id);

const prompt = row("p1", 100, "prompt", { input: "Fix the runner" });
const said = (id, time, output) => row(id, time, "text", { output });

test("messages stay inline in order with tool groups between them", () => {
  const items = [
    prompt,
    ...use(1, 101, 1, "Bash", '{"command":"npm test"}'),
    said("t1", 103, "Looking at it"),
    ...use(2, 104, 2, "Read", '{"file_path":"a.js"}'),
    ...use(3, 106, 3, "Bash", '{"command":"npm run lint"}'),
    said("t2", 108, "Done: fixed."),
    row("s1", 109, "stop", { input: "turn ended" }),
  ];
  const thread = chatThread([], grouped(items), A);
  assert.deepEqual(ids(thread), ["group:c1", "t1", "group:c2", "final:t2"]);
  assert.equal(thread[1].activity.type, "text");
  assert.equal(thread[2].activity.steps, 2);
  assert.equal(thread[3].message.body, "Done: fixed.");
});

test("a single tool use between messages is a one-step group", () => {
  const items = [prompt, said("t1", 101, "Start"), ...use(1, 102, 1, "Bash", '{"command":"npm test"}'), said("t2", 104, "Next")];
  const [, group] = chatThread([], grouped(items), A);
  assert.equal(group.activity.type, "group");
  assert.equal(groupLabel(group.activity), "Ran Bash · npm test");
});

test("a group label names the distinct tools in order", () => {
  const group = chatFlow(grouped([prompt, ...use(1, 101, 1, "Bash"), ...use(2, 103, 2, "Read"), ...use(3, 105, 3, "Bash")]), [], A).rows[0];
  assert.equal(groupLabel(group), "Ran 3 tools · Bash, Read");
});

test("the newest group of a running turn is live and an older one collapses when a text follows", () => {
  const items = [prompt, ...use(1, 101, 1, "Bash"), said("t1", 103, "Checking"), ...use(2, 104, 2, "Read")];
  const rows = chatFlow(grouped(items), [], A).rows;
  assert.deepEqual(rows.map(item => [item.type, item.live]), [["group", false], ["text", undefined], ["group", true]]);
  const later = chatFlow(grouped([...items, said("t2", 106, "Found it")]), [], A).rows;
  assert.deepEqual(later.map(item => [item.type, item.live]), [["group", false], ["text", undefined], ["group", false], ["text", undefined]]);
});

test("a running turn ending in a text has no live group", () => {
  const items = [prompt, ...use(1, 101, 1, "Bash"), said("t1", 103, "Waiting")];
  assert.deepEqual(chatFlow(grouped(items), [], A).rows.map(item => item.live), [false, undefined]);
});

test("a finished turn has no live group", () => {
  const items = [prompt, ...use(1, 101, 1, "Bash"), row("s1", 103, "stop", { input: "turn ended" })];
  assert.deepEqual(chatFlow(grouped(items), [], A).rows.map(item => item.live), [false]);
});

test("a subagent run is its own row and splits the tool groups around it", () => {
  const run = { subagent: { id: "run1", type: "Explore" } };
  const items = [
    prompt,
    ...use(1, 101, 1, "Bash"),
    { ...row("c2", 103, "tool_call", { tool: "Task", callId: "k2", input: '{"description":"survey"}' }), ...run },
    { ...row("r2", 104, "tool_result", { tool: "Task", callId: "k2", output: "" }), ...run },
    ...use(3, 105, 3, "Read"),
    said("t1", 107, "Done"),
  ];
  const rows = chatFlow(grouped(items), [], A).rows;
  assert.deepEqual(rows.map(item => item.type), ["group", "subagent", "group", "text"]);
});

test("a final text the session already posted is not repeated; its tool groups stay", () => {
  const chat = { id: "m1", time: 108, kind: "Message", from: A, body: "Done: fixed.\n" };
  const items = [prompt, ...use(1, 101, 1, "Bash"), ...use(2, 103, 2, "Read"), said("t2", 106, "Done: fixed."), row("s1", 107, "stop", { input: "turn ended" })];
  const shown = chatThread([chat], grouped(items), A);
  assert.deepEqual(ids(shown), ["group:c1", "m1"]);
  assert.equal(shown[0].activity.steps, 2);
});

test("a blank text does not split a tool group", () => {
  const items = [prompt, ...use(1, 101, 1, "Bash"), said("t1", 103, "   "), ...use(2, 104, 2, "Read"), said("t2", 106, "Next")];
  const rows = chatFlow(grouped(items), [], A).rows;
  assert.deepEqual(rows.map(item => [item.type, item.steps]), [["group", 2], ["text", undefined]]);
});

test("a chat message that arrives mid tool run splits the group so newer tool rows sit below it", () => {
  // A Cursor turn emits no texts, so its whole run of tools is one group that started before the operator's compact notice.
  const notice = { id: "m1", time: 104, kind: "Message", from: "system", to: A, body: "[ai-collab] The operator asked to compact" };
  const reply = { id: "m2", time: 106, kind: "Message", from: A, to: "operator", body: "Merged a-ui; fixing 4 UI test regressions" };
  const items = [prompt, ...use(1, 101, 1, "Read"), ...use(2, 103, 2, "Shell"), ...use(3, 105, 3, "Read"), ...use(4, 107, 4, "Write"), ...use(5, 109, 5, "Read")];
  const thread = chatThread([notice, reply], grouped(items), A);
  assert.deepEqual(ids(thread), ["group:c1", "m1", "group:c3", "m2", "group:c4"]);
  const times = thread.map(item => (item.message || item.activity).time);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.deepEqual(thread.filter(item => item.activity).map(item => [item.activity.steps, item.activity.live]), [[2, false], [1, false], [2, true]]);
});
