import assert from "node:assert/strict";
import { test } from "node:test";
import { readableText } from "../web/lib/activity-rows.js";

test("Claude Code's task notifications and subagent hand-backs read as plain text", () => {
  const notice = "<task-notification>\n<task-id>bg0rdbkrd</task-id>\n<status>completed</status>\n<summary>Background command \"wait for cursor\" completed (exit code 0)</summary>\n</task-notification>";
  assert.deepEqual(readableText(notice), { label: "Task notification", text: "Background command \"wait for cursor\" completed (exit code 0)" });
  const handBack = "<agent-message from=\"a3c26b3960e76171e\">\n[Subagent hand-back] The text below is the final report. The report follows:\n  The README is now 52 lines.\n  \n  - commit one\n</agent-message>";
  assert.deepEqual(readableText(handBack), { label: "Subagent report", text: "The README is now 52 lines.\n\n- commit one" });
});

test("pasted blocks become a text code block and plain text stays as it is", () => {
  assert.equal(readableText("<pasted_content id=\"28d7\">\nline one\n</pasted_content id=\"28d7\">\n\n extremely messy").text, "```text\nline one\n```\n\n extremely messy");
  assert.deepEqual(readableText("runs are named local-<epoch>"), { label: "", text: "runs are named local-<epoch>" });
  assert.equal(readableText("<system-reminder>\nbe brief\n</system-reminder>").text, "be brief");
});
