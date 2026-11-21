import assert from "node:assert/strict";
import { test } from "node:test";
import { activityRows, groupSubagents } from "../web/lib/activity-rows.js";
import { chatThread, chatTurns, turnLabel } from "../web/lib/chat-turns.js";

const A = "claude#abc12345";
const row = (id, time, type, extra = {}) => ({ id, time, type, agent: A, ...extra });
const call = (id, time, n, input = '{"command":"ls"}') => [
  row("c" + id, time, "tool_call", { tool: "Bash", callId: "k" + n, input }),
  row("r" + id, time + 1, "tool_result", { tool: "Bash", callId: "k" + n, output: "ok" }),
];
const grouped = items => groupSubagents(activityRows(items));

const finished = [
  row("p1", 100, "prompt", { input: "Fix the flaky\nrunner test" }),
  ...call(1, 101, 1),
  row("t1", 103, "text", { output: "Looking at it" }),
  ...call(2, 104, 2),
  row("t2", 106, "text", { output: "Done: fixed." }),
  row("s1", 107, "stop", { input: "turn ended" }),
];

test("a finished turn folds into one row and its last text becomes a message", () => {
  const { rows, messages } = chatTurns(grouped(finished));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "turn");
  assert.equal(rows[0].steps, 2);
  assert.equal(turnLabel(rows[0]), "Working on Fix the flaky runner test · 2 steps");
  assert.deepEqual(rows[0].rows.map(item => item.type), ["tool_call", "text", "tool_call"]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body, "Done: fixed.");
  assert.equal(messages[0].from, A);
});

test("a running turn stays flat, without its prompt", () => {
  const { rows, messages } = chatTurns(grouped(finished.slice(0, 4)));
  assert.deepEqual(rows.map(item => item.type), ["tool_call", "text"]);
  assert.equal(messages.length, 0);
});

test("a later prompt ends the previous turn even without a stop", () => {
  const items = [...finished.slice(0, 5), row("p2", 200, "prompt", { input: "next" }), ...call(3, 201, 3)];
  const { rows, messages } = chatTurns(grouped(items));
  assert.deepEqual(rows.map(item => item.type), ["turn", "tool_call"]);
  assert.equal(messages[0].body, "Looking at it");
});

test("a final text already in chat from the session is not shown twice", () => {
  const chat = { id: "m1", time: 108, kind: "Message", from: A, body: "Done: fixed.\n" };
  const { messages, rows } = chatTurns(grouped(finished), [chat], A);
  assert.equal(messages.length, 0);
  assert.equal(rows[0].steps, 2);
  const other = { ...chat, from: "codex#zzz" };
  assert.equal(chatTurns(grouped(finished), [other], A).messages.length, 1);
  const old = { ...chat, time: 5000 };
  assert.equal(chatTurns(grouped(finished), [old], A).messages.length, 1);
});

test("a turn with only a final text shows the message and no fold row", () => {
  const { rows, messages } = chatTurns(grouped([row("t", 10, "text", { output: "hi" }), row("s", 11, "stop")]));
  assert.equal(rows.length, 0);
  assert.equal(messages[0].body, "hi");
});

test("the summary falls back to the first tool input, then to the task", () => {
  const noPrompt = chatTurns(grouped([...call(1, 10, 1, '{"command":"npm test"}'), row("s", 20, "stop")]));
  assert.equal(turnLabel(noPrompt.rows[0]), "Working on npm test · 1 step");
  const bare = chatTurns(grouped([row("t0", 10, "text", { output: "thinking" }), row("t1", 11, "text", { output: "x" }), row("s", 12, "stop")]));
  assert.equal(turnLabel(bare.rows[0]), "Working on the task");
});

test("the thread orders messages and turns by time, the fold before its final message", () => {
  const ask = { id: "m0", time: 99, kind: "Message", from: "operator", body: "go" };
  const thread = chatThread([ask], grouped(finished), A);
  assert.deepEqual(thread.map(item => item.message ? item.message.id : item.activity.type), ["m0", "turn", "final:t2"]);
});
