import assert from "node:assert/strict";
import { test } from "node:test";
import { projectViewCounts } from "../web/lib/selection.js";

test("each view badge counts that project's tasks and patterns, with the tasks waiting on a decision", () => {
  const data = {
    tasks: { tasks: [
      { id: "a", question: { text: "Which?", answer: null } },
      { id: "b", question: { text: "Which?", answer: { text: "that" } } },
      { id: "c" },
    ] },
    patterns: [{ name: "pair" }, { name: "crew" }],
  };
  assert.deepEqual(projectViewCounts(data), { tasks: 3, waiting: 1, patterns: 2 });
  assert.deepEqual(projectViewCounts({}), { tasks: 0, waiting: 0, patterns: 0 });
});
