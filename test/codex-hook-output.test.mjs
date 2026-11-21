import assert from "node:assert/strict";
import { test } from "node:test";
import { hookOutput } from "../lib/format.mjs";

test("codex hook output carries only hookSpecificOutput, since Codex rejects unknown fields", () => {
  assert.deepEqual(hookOutput("codex", "UserPromptSubmit", "x"), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "x" } });
});
