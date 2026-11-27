import assert from "node:assert/strict";
import { test } from "node:test";
import { questionOperations, questionText } from "../web/lib/a2ui.js";

test("a blocking question's card shows its text without the wire prefix", () => {
  assert.equal(questionText("IMPORTANT, the agent waits for this answer: Ship it?"), "Ship it?");
  assert.equal(questionText("Ship it?"), "Ship it?");
  const ops = questionOperations("abcdef123456", "IMPORTANT, the agent waits for this answer: Ship it?");
  const body = ops.flatMap(op => op.updateComponents?.components || []).find(component => component.id === "body");
  assert.equal(JSON.stringify(body).includes("IMPORTANT"), false);
  assert.equal(JSON.stringify(body).includes("Ship it?"), true);
});
