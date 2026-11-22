import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIVITY_MAX_BYTES, activityEvents, buildActivity } from "../lib/activity.mjs";
import { eventToEnvelope } from "../lib/agui.mjs";
import { activityRows, summarize } from "../web/lib/activity-rows.js";

test("a Claude PostToolUse result carries its call's input", () => {
  assert.deepEqual(activityEvents("claude", "posttooluse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "toolu_1", tool_response: { stdout: "a" } }),
    [{ type: "tool_result", tool: "Bash", callId: "toolu_1", output: "a", input: { command: "ls" } }]);
});

test("a Claude PostToolUseFailure error carries its call's input", () => {
  assert.deepEqual(activityEvents("claude", "posttoolusefailure", { tool_name: "Bash", tool_input: { command: "false" }, tool_use_id: "toolu_2", error: "Exit code 1" }),
    [{ type: "error", tool: "Bash", callId: "toolu_2", output: "Exit code 1", input: { command: "false" } }]);
});

test("a Cursor result still travels with the call, not with a duplicate input", () => {
  const [call, result] = activityEvents("cursor", "posttooluse", { tool_name: "Shell", tool_input: { command: "ls" }, tool_output: "{\"stdout\":\"a\"}", tool_use_id: "c1" });
  assert.equal(call.type, "tool_call");
  assert.equal(result.input, undefined);
});

test("a result without tool_input has no input key", () => {
  const [result] = activityEvents("claude", "posttooluse", { tool_name: "Bash", tool_use_id: "toolu_3", tool_response: "a" });
  assert.equal("input" in result, false);
});

test("a result with a huge input still fits the ntfy cap and keeps its output", () => {
  const event = { type: "tool_result", tool: "Bash", callId: "t", input: { command: "x".repeat(20_000) }, output: "done" };
  const cfg = { peer: "alice", session: "aabbccddeeff0011" };
  const { message } = buildActivity(cfg, "claude", event);
  assert.ok(Buffer.byteLength(message) <= ACTIVITY_MAX_BYTES);
  const envelope = eventToEnvelope(message);
  assert.equal(envelope.output, "done");
  assert.match(envelope.input, /truncated/);
});

test("a lone Bash result summarizes to its one-line command", () => {
  const input = JSON.stringify({ command: "npm test\necho done" });
  assert.equal(summarize(input), "npm test");
});

test("a result joined to its call keeps a single call row, with the result under it", () => {
  const items = [
    { id: "1", type: "tool_call", tool: "Bash", callId: "t", input: JSON.stringify({ command: "ls" }) },
    { id: "2", type: "tool_result", tool: "Bash", callId: "t", input: JSON.stringify({ command: "ls" }), output: "a" },
  ];
  const rows = activityRows(items);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "tool_call");
  assert.equal(rows[0].result.id, "2");
});
