import assert from "node:assert/strict";
import { test } from "node:test";
import { activityRows, groupSubagents } from "../web/lib/activity-rows.js";
import { chatTurns, turnSummary } from "../web/lib/chat-turns.js";
import { completionRows, liveRows, sessionTurns } from "../web/lib/project-feed.js";
import * as mode from "../lib/mode.mjs";
import * as machine from "../lib/machine-prompt.mjs";

const A = "claude#abc12345";
const row = (id, time, type, extra = {}) => ({ id, time, type, agent: A, ...extra });
const grouped = items => groupSubagents(activityRows(items));
const turnsOf = items => sessionTurns(grouped(items));
const NOTICE = "<task-notification><summary>Build done</summary></task-notification>";
const HANDBACK = "<agent-message from=\"codex#def67890\">Lint clean</agent-message>";
const WAKE = "Read the pending AI Collab operator messages for this exact session and reply to the operator in the same AI Collab conversation.";
// A harness message arriving as a text row, as lib/activity.mjs stores it.
const notice = (id, time) => row(id, time, "text", { tool: "Agent message", output: NOTICE });
const reply = (id, time, output) => row(id, time, "text", { output });

test("the module that runs in the browser and the server share one prompt rule", () => {
  assert.equal(mode.operatorPrompt, machine.operatorPrompt);
  assert.equal(mode.machinePrompt, machine.machinePrompt);
  assert.equal(mode.WAKE_PROMPT, machine.WAKE_PROMPT);
});

test("a turn opened by a task notification with no reply gets no completion row", () => {
  const items = [notice("n1", 100), row("c1", 101, "tool_call", { tool: "Bash", callId: "k1", input: '{"command":"ls"}' }), row("s1", 102, "stop", { input: "turn ended" })];
  assert.deepEqual(completionRows(turnsOf(items)), []);
});

test("a machine prompt row opens a turn that still counts when the agent replied", () => {
  const items = [
    row("p1", 100, "prompt", { input: NOTICE }),
    reply("t1", 101, "Build passed."),
    row("s1", 102, "stop", { input: "turn ended" }),
  ];
  assert.deepEqual(completionRows(turnsOf(items)).map(item => [item.text, item.turns]), [["Build passed.", 1]]);
});

test("a harness message after the reply does not replace the reply as the completion text", () => {
  const items = [row("p1", 100, "prompt", { input: "Fix it" }), reply("t1", 101, "Fixed."), notice("n1", 102), row("s1", 103, "stop", { input: "turn ended" })];
  assert.deepEqual(completionRows(turnsOf(items)).map(item => item.text), ["Fixed."]);
});

test("a typed prompt with no reply gets a row with no text, never the prompt as text", () => {
  const items = [row("p1", 100, "prompt", { input: "Refactor the list" }), row("c1", 101, "tool_call", { tool: "Read", callId: "k1", input: '{"file_path":"a.js"}' }), row("s1", 102, "stop", { input: "turn ended" })];
  assert.deepEqual(completionRows(turnsOf(items)), [{ id: "done:s1", type: "completion", agent: A, time: 102, text: "", turns: 1 }]);
});

test("a wake prompt is not the operator, so its turn with no reply gets no row", () => {
  const items = [row("p1", 100, "prompt", { input: WAKE }), row("s1", 101, "stop", { input: "turn ended" })];
  assert.deepEqual(completionRows(turnsOf(items)), []);
});

test("consecutive completions of one session collapse into one row with its turn count and last text", () => {
  const items = [
    row("p1", 100, "prompt", { input: "one" }), reply("t1", 101, "First."), row("s1", 102, "stop", { input: "turn ended" }),
    row("p2", 103, "prompt", { input: "two" }), reply("t2", 104, "Second."), row("s2", 105, "stop", { input: "turn ended" }),
    row("p3", 106, "prompt", { input: "three" }), reply("t3", 107, "Third."), row("s3", 108, "stop", { input: "turn ended" }),
  ];
  assert.deepEqual(completionRows(turnsOf(items)).map(item => [item.id, item.turns, item.text, item.time]), [["done:s1", 3, "Third.", 108]]);
});

test("completions of different sessions do not collapse", () => {
  const other = { agent: "codex#def67890" };
  const items = [
    row("p1", 100, "prompt", { input: "one" }), reply("t1", 101, "First."), row("s1", 102, "stop", { input: "turn ended" }),
    { ...row("p2", 103, "prompt", { input: "lint" }), ...other }, { ...reply("t2", 104, "Clean."), ...other }, { ...row("s2", 105, "stop", { input: "turn ended" }), ...other },
  ];
  assert.deepEqual(completionRows(turnsOf(items)).map(item => [item.agent, item.turns]), [[A, 1], ["codex#def67890", 1]]);
});

test("a live row names the typed prompt, else the latest tool call, else nothing", () => {
  const typed = [row("p1", 100, "prompt", { input: "Update the docs" }), row("c1", 101, "tool_call", { tool: "Bash", callId: "k1", input: '{"command":"npm run build"}' })];
  assert.deepEqual(liveRows(turnsOf(typed), grouped(typed), 101_000).map(item => item.summary), ["Update the docs"]);

  const machineOpened = [notice("n1", 100), row("c1", 101, "tool_call", { tool: "Read", callId: "k1", input: '{"file_path":"web/app/home.jsx"}' })];
  assert.deepEqual(liveRows(turnsOf(machineOpened), grouped(machineOpened), 101_000).map(item => item.summary), ["web/app/home.jsx"]);

  const bare = [notice("n1", 100)];
  assert.deepEqual(liveRows(turnsOf(bare), grouped(bare), 100_500).map(item => [item.agent, item.summary]), [[A, ""]]);
});

test("a timeline turn label never names a machine prompt", () => {
  const items = [notice("n1", 100), row("c1", 101, "tool_call", { tool: "Bash", callId: "k1", input: '{"command":"ls"}' }), row("r1", 102, "tool_result", { tool: "Bash", callId: "k1", output: "ok" }), row("s1", 103, "stop", { input: "turn ended" })];
  const [turn] = chatTurns(grouped(items)).rows;
  assert.equal(turn.summary, "ls");
  assert.equal(turnSummary({ input: NOTICE }, []), "the task");
  assert.equal(turnSummary({ input: HANDBACK }, []), "the task");
});
