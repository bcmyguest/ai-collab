import assert from "node:assert/strict";
import { test } from "node:test";
import { activityRows, groupSubagents } from "../web/lib/activity-rows.js";
import { completionRows, liveRows, projectThread, sessionTurns, withoutAnswered } from "../web/lib/project-feed.js";
import { WORKING_MS } from "../web/lib/session-state.js";

const A = "claude#abc12345";
const B = "codex#def67890";
const row = (id, time, type, extra = {}) => ({ id, time, type, agent: A, ...extra });
const grouped = items => groupSubagents(activityRows(items));
const turnsOf = items => sessionTurns(grouped(items));

const finished = [
  row("p1", 100, "prompt", { input: "Fix the flaky\nrunner test" }),
  row("c1", 101, "tool_call", { tool: "Bash", callId: "k1", input: '{"command":"ls"}' }),
  row("r1", 102, "tool_result", { tool: "Bash", callId: "k1", output: "ok" }),
  row("t1", 103, "text", { output: "Looking at it" }),
  row("t2", 106, "text", { output: "Done: fixed.\n\nDetails follow." }),
  row("s1", 107, "stop", { input: "turn ended" }),
];

test("a finished turn becomes one completion row named by the first line of its final message", () => {
  assert.deepEqual(completionRows(turnsOf(finished)), [
    { id: "done:s1", type: "completion", agent: A, time: 107, text: "Done: fixed." },
  ]);
});

test("a session-ended or subagent stop, or a turn without rows, adds no completion row", () => {
  const ended = [...finished.slice(0, 5), row("s1", 107, "stop", { input: "session ended · exit" })];
  assert.deepEqual(completionRows(turnsOf(ended)), []);
  const subagent = [row("s2", 110, "stop", { input: "subagent finished" }), row("s3", 111, "stop", { input: "turn ended" })];
  assert.deepEqual(completionRows(turnsOf(subagent)), []);
});

test("a running turn with a recent row is live, even without an open tool call", () => {
  const items = finished.slice(0, 4);
  assert.deepEqual(completionRows(turnsOf(items)), []);
  assert.deepEqual(liveRows(turnsOf(items), grouped(items), 104_000).map(item => [item.agent, item.summary]), [[A, "Fix the flaky runner test"]]);
});

test("a turn whose newest row is older than WORKING_MS is not live", () => {
  const items = finished.slice(0, 4);
  assert.deepEqual(liveRows(turnsOf(items), grouped(items), 103_000 + WORKING_MS), []);
});

test("a turn with a stop is not live", () => {
  assert.deepEqual(liveRows(turnsOf(finished), grouped(finished), 108_000), []);
});

test("a session with a running subagent is live", () => {
  const run = { subagent: { id: "run1", type: "Explore" } };
  const items = [
    row("p1", 100, "prompt", { input: "Survey the repo" }),
    { ...row("c1", 101, "tool_call", { tool: "Grep", callId: "k1", input: '{"pattern":"x"}' }), ...run },
    { ...row("r1", 102, "tool_result", { tool: "Grep", callId: "k1", output: "" }), ...run },
    row("s1", 103, "stop", { input: "turn ended" }),
  ];
  assert.deepEqual(liveRows(turnsOf(items), grouped(items), 103_500).map(item => item.agent), [A]);
});

test("completion rows from two sessions sort by time and keep their sessions", () => {
  const other = [
    { ...row("p2", 90, "prompt", { input: "Lint" }), agent: B },
    { ...row("t3", 95, "text", { output: "Lint clean" }), agent: B },
    { ...row("s2", 96, "stop", { input: "turn ended" }), agent: B },
  ];
  assert.deepEqual(completionRows(turnsOf([...finished, ...other])).map(item => [item.agent, item.text]), [
    [B, "Lint clean"],
    [A, "Done: fixed."],
  ]);
});

test("a final message the session already posted within 30 s is not repeated in its completion row", () => {
  const same = { id: "m9", time: 105, from: A, body: "Done: fixed.\n\nDetails follow." };
  assert.deepEqual(completionRows(turnsOf(finished), [same]).map(item => item.text), [""]);
  const late = { ...same, time: 150 };
  assert.deepEqual(completionRows(turnsOf(finished), [late]).map(item => item.text), ["Done: fixed."]);
  const other = { ...same, from: B };
  assert.deepEqual(completionRows(turnsOf(finished), [other]).map(item => item.text), ["Done: fixed."]);
});

test("the project thread merges completion rows with chat messages by time", () => {
  const messages = [
    { id: "m1", time: 98, from: "operator", body: "status?" },
    { id: "m2", time: 120, from: A, body: "question" },
  ];
  const thread = projectThread(messages, turnsOf(finished));
  assert.deepEqual(thread.map(entry => entry.message?.id ?? entry.activity.id), ["m1", "done:s1", "m2"]);
});

test("an answer whose question card is listed is hidden; an answer without its card stays", () => {
  const messages = [
    { id: "q1", time: 10, kind: "Question", from: A, body: "Which timer?", question: "q1" },
    { id: "a1", time: 11, kind: "Message", from: "operator", to: A, body: "fast", replyTo: "q1" },
    { id: "ap1", time: 12, kind: "Approval", from: A, body: "Run it?", approval: { id: "ap1" } },
    { id: "a2", time: 13, kind: "Message", from: "operator", to: A, body: "yes", replyTo: "ap1" },
    { id: "a3", time: 14, kind: "Message", from: "operator", to: A, body: "orphan", replyTo: "gone" },
  ];
  assert.deepEqual(withoutAnswered(messages).map(message => message.id), ["q1", "ap1", "a3"]);
});
