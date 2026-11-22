import assert from "node:assert/strict";
import { test } from "node:test";
import { pendingCounts, pendingLabel } from "../web/lib/pending-summary.js";

test("pending label counts questions, choice cards and approvals for the Home indicator", () => {
  assert.equal(pendingLabel([]), "");
  assert.equal(pendingLabel(undefined), "");
  assert.equal(pendingLabel([{ kind: "Question" }]), "1 question");
  assert.equal(pendingLabel([{ kind: "Question" }, { kind: "Question" }]), "2 questions");
  assert.equal(pendingLabel([{ kind: "Approval", approval: {} }]), "1 approval");
  assert.equal(pendingLabel([{ kind: "Approval", approval: {} }, { kind: "Approval", approval: {} }]), "2 approvals");
  assert.equal(pendingLabel([{ kind: "Approval", approval: { questions: [] } }, { kind: "Question" }]), "2 questions", "a choice card asks a question");
  assert.equal(pendingLabel([{ kind: "Approval", approval: {} }, { kind: "Question" }, { kind: "Question" }]), "1 approval · 2 questions");
});

test("pending counts split approvals from questions", () => {
  assert.deepEqual(pendingCounts([]), { approvals: 0, questions: 0 });
  assert.deepEqual(pendingCounts([{ kind: "Approval", approval: { questions: [{}] } }]), { approvals: 0, questions: 1 });
});
