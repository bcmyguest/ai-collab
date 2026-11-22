import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanQuestions, parseChoice } from "../lib/approvals.mjs";
import { approvalOperations, choiceAnswers, surfaceAnswer } from "../web/lib/a2ui.js";

const ID = "0123456789ab";
const NOW = Date.parse("2026-11-21T10:00:00Z");
const questions = cleanQuestions([
  { question: "Deploy target?", header: "Env", multiSelect: false, options: [{ label: "staging", description: "Safe" }, { label: "production", description: "Live" }] },
  { question: "Checks?", multiSelect: true, options: [{ label: "lint", description: "Style" }, { label: "test", description: "Unit" }] },
]);
const action = (name, surfaceId, context) => ({ name, surfaceId, sourceComponentId: "x", timestamp: "2026-11-21T10:00:00Z", context });

test("a permission button maps to its decision", () => {
  assert.deepEqual(surfaceAnswer(action("decide", "approval-" + ID, { id: ID, decision: "allow" })), { kind: "approval", id: ID, decision: "allow" });
  assert.deepEqual(surfaceAnswer(action("decide", "approval-" + ID, { id: ID, decision: "deny" })), { kind: "approval", id: ID, decision: "deny" });
});

test("a choice submit maps to its picks and Other text", () => {
  const answer = surfaceAnswer(action("answer", "approval-" + ID, { id: ID, picks: [["staging"], ["lint", "test"]], other: ["", "  "] }));
  assert.deepEqual(answer, { kind: "approval", id: ID, picks: [["staging"], ["lint", "test"]], other: ["", "  "] });
});

test("a question reply maps to its question and body", () => {
  assert.deepEqual(surfaceAnswer(action("reply", "question-" + ID, { question: ID, answer: "main" })), { kind: "question", question: ID, body: "main" });
});

test("an action on another surface, with another name, or with bad fields maps to nothing", () => {
  assert.equal(surfaceAnswer(action("decide", "approval-fffffffffffff", { id: ID, decision: "allow" })), null);
  assert.equal(surfaceAnswer(action("decide", "approval-" + ID, { id: ID, decision: "maybe" })), null);
  assert.equal(surfaceAnswer(action("reply", "approval-" + ID, { question: ID, answer: "x" })), null);
  assert.equal(surfaceAnswer(action("answer", "approval-" + ID, { id: ID, picks: "lint", other: [] })), null);
  assert.equal(surfaceAnswer(action("answer", "approval-" + ID, { id: ID, picks: [[1]], other: [] })), null);
  assert.equal(surfaceAnswer(action("decide", "approval-" + ID, ["allow"])), null);
  assert.equal(surfaceAnswer({ name: "decide", surfaceId: "approval-" + ID }), null);
  assert.equal(surfaceAnswer(null), null);
});

test("choice answers join picks with Other as the chat card does", () => {
  assert.deepEqual(choiceAnswers(questions, [["staging"], ["lint", "test"]], ["", ""]), {
    "Deploy target?": "staging", "Checks?": "lint, test",
  });
  // Single-select: a typed Other answer replaces the pick.
  assert.deepEqual(choiceAnswers(questions, [["staging"], []], ["canary ", ""]), { "Deploy target?": "canary", "Checks?": "" });
  // Multi-select: Other joins the picks.
  assert.deepEqual(choiceAnswers(questions, [["production"], ["lint"]], ["", "docs"]), { "Deploy target?": "production", "Checks?": "lint, docs" });
});

test("a choice reply built from the surface passes the server's choice check", () => {
  const picks = [["staging"], ["lint"]];
  const answers = choiceAnswers(questions, picks, ["", ""]);
  assert.ok(parseChoice(questions, JSON.stringify(answers)));
  assert.equal(parseChoice(questions, JSON.stringify({ "Deploy target?": "staging" })), null);
});

test("the choice a surface offers round-trips to a valid reply", () => {
  const approval = { id: ID, harness: "claude", tool: "AskUserQuestion", state: "pending", expiresAt: NOW + 60_000, questions };
  const ops = approvalOperations(approval, NOW);
  const submit = ops.find(op => op.updateComponents).updateComponents.components.find(c => c.id === "submit");
  assert.equal(submit.action.event.name, "answer");
  assert.equal(surfaceAnswer(action("answer", "approval-" + ID, { id: ID, picks: [["production"], ["test"]], other: ["", ""] })).kind, "approval");
});
