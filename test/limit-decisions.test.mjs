// One decision for a limit text, on the builder's detector path and the runner's path (lib/limits.ts isBlockingLimit).
import assert from "node:assert/strict";
import { test } from "node:test";
import { detectLimit, isBlockingLimit, limitFromRunError } from "../lib/limits.ts";

const CASES = [
  ["cursor", "Monthly quota exhausted", true],
  ["cursor", "quota exceeded for file uploads (max 10MB)", false],
  ["cursor", "ActionRequiredError: You've reached your limit of 3 background agents", false],
  ["cursor", "429 rate limit exceeded, please slow down", false],
  ["codex", "error: rate limit exceeded, try again at 2:00 AM", true],
  ["codex", "stream error: rate limit exceeded; retrying 1/5", false],
  ["codex", "error: Usage limit reached", true],
  ["claude", "Claude AI usage limit reached|1760000000", true],
];

for (const [harness, text, blocking] of CASES) {
  test(`${harness}: "${text}" blocks: ${blocking}, on both paths`, () => {
    assert.equal(isBlockingLimit(detectLimit(harness, text)), blocking, "builder path");
    assert.equal(isBlockingLimit(limitFromRunError(harness, text)), blocking, "runner path");
  });
}

test("a missing limit does not block", () => {
  assert.equal(isBlockingLimit(null), false);
});
