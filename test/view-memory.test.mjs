import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationKey, createMemory } from "../web/lib/view-memory.js";

test("a project's chat and activity share a draft key; each session has its own", () => {
  assert.equal(conversationKey("demo"), conversationKey("demo", ""));
  assert.notEqual(conversationKey("demo"), conversationKey("demo", "claude#0000000000000001"));
  assert.notEqual(conversationKey("demo", "claude#0000000000000001"), conversationKey("other", "claude#0000000000000001"));
  assert.notEqual(conversationKey("a b", ""), conversationKey("a", "b"));
});

test("memory keeps values, deletes on empty, and drops the oldest past max", () => {
  const memory = createMemory(2);
  memory.set("a", "draft a");
  assert.equal(memory.get("a", ""), "draft a");
  assert.equal(memory.get("missing", "fallback"), "fallback");
  memory.set("a", "");
  assert.equal(memory.get("a", ""), "");
  assert.equal(memory.size, 0);
  memory.set("a", 1); memory.set("b", 2); memory.set("a", 3); memory.set("c", 4);
  assert.equal(memory.get("b"), undefined);
  assert.deepEqual([memory.get("a"), memory.get("c"), memory.size], [3, 4, 2]);
});
