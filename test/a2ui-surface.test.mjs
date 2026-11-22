import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageProcessor } from "@a2ui/web_core/v0_9";
import { aiCollabCatalog, OptionPickerApi } from "../web/lib/a2ui-catalog.js";
import { A2UI_VERSION, IN_TERMINAL, approvalOperations, questionOperations, surfaceOf } from "../web/lib/a2ui.js";

const NOW = Date.parse("2026-11-21T10:00:00Z");
const ID = "0123456789ab";
const permission = { id: ID, harness: "claude", tool: "Bash", summary: "rm -rf build", state: "pending", expiresAt: NOW + 60_000 };
const choice = {
  id: ID, harness: "claude", tool: "AskUserQuestion", state: "pending", expiresAt: NOW + 60_000,
  questions: [
    { question: "Deploy target?", header: "Env", multiSelect: false, options: [
      { label: "staging", description: "Safe first step" }, { label: "production", description: "Live traffic", preview: "make deploy" }] },
    { question: "Checks?", multiSelect: true, options: [{ label: "lint" }, { label: "test" }] },
  ],
};

// Runs the operations through the A2UI processor; the basic catalog plus OptionPicker, as the browser builds it.
function validate(operations) {
  const processor = new MessageProcessor([aiCollabCatalog([OptionPickerApi])]);
  return processor.processMessagesWithErrors(operations);
}

function components(operations) {
  return operations.find(op => op.updateComponents).updateComponents.components;
}

test("every surface operation set passes the A2UI processor", () => {
  const sets = [
    approvalOperations(permission, NOW),
    approvalOperations({ ...permission, state: "allowed", decision: "allow" }, NOW),
    approvalOperations({ ...permission, terminal: true }, NOW),
    approvalOperations(choice, NOW),
    approvalOperations({ ...choice, terminal: true }, NOW),
    approvalOperations({ ...choice, state: "answered", answers: { "Deploy target?": "staging", "Checks?": "lint, test" } }, NOW),
    questionOperations(ID, "Which branch?", undefined),
    questionOperations(ID, "Which branch?", "main", "alice"),
  ];
  for (const operations of sets) assert.deepEqual(validate(operations), []);
});

test("operations use v0.9.1 and create one surface per id", () => {
  const operations = approvalOperations(permission, NOW);
  assert.deepEqual(operations.map(op => Object.keys(op).find(key => key !== "version")), ["createSurface", "updateComponents", "updateDataModel"]);
  assert.ok(operations.every(op => op.version === A2UI_VERSION));
  assert.equal(operations[0].createSurface.surfaceId, "approval-" + ID);
});

test("an open permission request offers Allow and Deny that carry the decision", () => {
  const buttons = components(approvalOperations(permission, NOW)).filter(c => c.component === "Button");
  assert.deepEqual(buttons.map(b => b.action.event.context), [{ id: ID, decision: "allow" }, { id: ID, decision: "deny" }]);
  assert.ok(buttons.every(b => b.action.event.name === "decide"));
});

test("a closed or terminal permission request shows its outcome without buttons", () => {
  const closed = components(approvalOperations({ ...permission, state: "allowed", decision: "allow", by: "carol" }, NOW));
  assert.equal(closed.some(c => c.component === "Button"), false);
  assert.equal(closed.find(c => c.id === "status").text, "Allowed from the phone · carol");
  const terminal = components(approvalOperations({ ...permission, terminal: true }, NOW));
  assert.equal(terminal.find(c => c.id === "status").text, IN_TERMINAL);
  assert.equal(terminal.some(c => c.component === "Button"), false);
});

test("an expired permission request reads as expired", () => {
  const expired = components(approvalOperations({ ...permission, expiresAt: NOW - 1 }, NOW));
  assert.equal(expired.find(c => c.id === "status").text, "Expired: answered in the terminal or timed out");
});

test("an open choice gives each option its description and an Other field", () => {
  const ops = approvalOperations(choice, NOW);
  const pickers = components(ops).filter(c => c.component === "OptionPicker");
  assert.equal(pickers.length, 2);
  assert.deepEqual(pickers[0].options[0], { label: "staging", value: "staging", description: "Safe first step" });
  assert.equal(pickers[0].options[1].preview, "make deploy");
  assert.equal(pickers[0].multiSelect, false);
  assert.equal(pickers[1].multiSelect, true);
  assert.deepEqual(pickers[0].other, { path: "/other/0" });
  assert.equal(components(ops).filter(c => c.component === "TextField").length, 2);
  const submit = components(ops).find(c => c.id === "submit-label" || c.id === "submit");
  assert.ok(submit);
});

test("Submit checks that every question has a pick or Other text", () => {
  const submit = components(approvalOperations(choice, NOW)).find(c => c.id === "submit");
  assert.equal(submit.checks.length, 1);
  const { call, args } = submit.checks[0].condition;
  assert.equal(call, "and");
  assert.equal(args.values.length, 2);
  assert.equal(args.values[0].call, "or");
  assert.deepEqual(args.values[1].args.values[0], { call: "required", args: { value: { path: "/picks/1" } } });
  const single = components(approvalOperations({ ...choice, questions: choice.questions.slice(0, 1) }, NOW)).find(c => c.id === "submit");
  assert.equal(single.checks[0].condition.call, "or");
});

test("a closed choice shows the chosen labels read-only and the outcome", () => {
  const ops = approvalOperations({ ...choice, state: "answered", decision: "allow", by: "dana", answers: { "Deploy target?": "staging", "Checks?": "lint, test" } }, NOW);
  const parts = components(ops);
  assert.equal(parts.some(c => c.component === "Button" || c.component === "TextField"), false);
  const first = parts.find(c => c.id === "q0-pick");
  assert.equal(first.readOnly, true);
  assert.deepEqual(first.value, ["staging"]);
  assert.deepEqual(parts.find(c => c.id === "q1-pick").value, ["lint", "test"]);
  assert.equal(parts.find(c => c.id === "status").text, "Answered from the phone · dana");
});

test("a typed Other answer that matches no option shows as the answer", () => {
  const parts = components(approvalOperations({ ...choice, state: "answered", answers: { "Deploy target?": "canary" } }, NOW));
  assert.equal(parts.find(c => c.id === "q0-answer").text, "Answer: canary");
});

test("a question offers an answer field and a reply button until it is answered", () => {
  const open = components(questionOperations(ID, "Which branch?", undefined));
  assert.equal(open.find(c => c.id === "submit").action.event.name, "reply");
  assert.deepEqual(open.find(c => c.id === "submit").action.event.context, { question: ID, answer: { path: "/answer" } });
  const done = components(questionOperations(ID, "Which branch?", "main", "alice"));
  assert.equal(done.some(c => c.component === "Button" || c.component === "TextField"), false);
  assert.equal(done.find(c => c.id === "status").text, "Answered: main · alice");
});

test("surfaceOf maps only approval and question entries with valid ids", () => {
  const approval = surfaceOf({ kind: "Approval", approval: permission }, NOW);
  assert.equal(approval.id, "approval-" + ID);
  assert.equal(surfaceOf({ kind: "Question", question: ID, body: "Which?" }, NOW).id, "question-" + ID);
  assert.equal(surfaceOf({ kind: "Message", body: "hi" }, NOW), null);
  assert.equal(surfaceOf({ kind: "Approval", approval: { ...permission, id: "../etc" } }, NOW), null);
  assert.equal(surfaceOf({ kind: "Question", question: "nothex", body: "x" }, NOW), null);
});

test("the processor rejects an option without a label", () => {
  const ops = approvalOperations(choice, NOW);
  const broken = structuredClone(ops);
  components(broken).find(c => c.id === "q0-pick").options[0] = { value: "staging" };
  assert.notDeepEqual(validate(broken), []);
});

test("an open view-only permission card says AFK is off and how to answer here", async () => {
  const { approvalOperations, IN_TERMINAL_HINT } = await import("../web/lib/a2ui.js");
  const ops = approvalOperations({ id: "aaaaaaaaaaaa", tool: "Bash", summary: "ls", terminal: true, deadline: Date.now() + 60000 }, Date.now());
  const components = ops.find(op => op.updateComponents).updateComponents.components;
  assert.equal(components.find(c => c.id === "hint")?.text, IN_TERMINAL_HINT);
});
