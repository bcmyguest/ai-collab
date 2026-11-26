import assert from "node:assert/strict";
import { test } from "node:test";
import { authorCommand } from "../lib/catalog/author.ts";

test("the writing agent's argv is one non-interactive turn per harness, with the model flag only when named", () => {
  assert.deepEqual(authorCommand("claude", "hi", ""), ["claude", ["-p", "hi"]]);
  assert.deepEqual(authorCommand("claude", "hi", "m1"), ["claude", ["-p", "--model", "m1", "hi"]]);
  assert.deepEqual(authorCommand("codex", "hi", ""), ["codex", ["exec", "hi"]]);
  assert.deepEqual(authorCommand("codex", "hi", "m1"), ["codex", ["exec", "-m", "m1", "hi"]]);
  assert.deepEqual(authorCommand("cursor", "hi", ""), ["cursor-agent", ["-p", "--trust", "hi"]]);
  assert.deepEqual(authorCommand("cursor", "hi", "m1"), ["cursor-agent", ["-p", "--trust", "--model", "m1", "hi"]]);
  assert.deepEqual(authorCommand("opencode", "hi", ""), ["opencode", ["run", "hi"]]);
  assert.deepEqual(authorCommand("opencode", "hi", "m1"), ["opencode", ["run", "-m", "m1", "hi"]]);
});

test("an unknown harness has no writing command", () => {
  assert.equal(authorCommand("bogus", "x"), null);
});
