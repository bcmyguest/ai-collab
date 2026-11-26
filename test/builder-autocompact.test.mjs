import test from "node:test";
import assert from "node:assert/strict";
import { claudeSettings } from "../lib/builder.mjs";

test("Claude builders auto-compact at a 250k-token window", () => {
  const settings = claudeSettings(["UserPromptSubmit"]);
  assert.equal(settings.autoCompactEnabled, true);
  assert.equal(settings.autoCompactWindow, 250000);
});
