import assert from "node:assert/strict";
import { test } from "node:test";
import { fuzzyRank, fuzzyScore } from "../web/lib/fuzzy.js";

test("fuzzyScore ranks prefix over word start over subsequence", () => {
  assert.equal(fuzzyScore("cod", "codex:gpt-5-codex"), 3);
  assert.equal(fuzzyScore("gpt", "codex:gpt-5-codex"), 2);
  assert.equal(fuzzyScore("cg5", "codex:gpt-5-codex"), 1);
  assert.equal(fuzzyScore("codex g5", "codex:gpt-5-codex"), 1);
  assert.equal(fuzzyScore("zz", "codex:gpt-5-codex"), 0);
  assert.equal(fuzzyScore("", "anything"), 1);
  assert.equal(fuzzyScore("a", ""), 0);
});

test("fuzzyRank keeps the best fields, stable order and the limit", () => {
  const options = [{ id: "claude" }, { id: "codex" }, { id: "codex:gpt-5-codex", model: "gpt-5-codex" }, { id: "claude#0123456789abcdef", name: "Fix the GPT client" }];
  const fields = option => [option.id, option.name, option.model];
  assert.deepEqual(fuzzyRank("gpt", options, fields).map(o => o.id), ["codex:gpt-5-codex", "claude#0123456789abcdef"]);
  assert.deepEqual(fuzzyRank("c", options, fields, 2).map(o => o.id), ["claude", "codex"]);
  assert.deepEqual(fuzzyRank("", options, fields).length, 4);
});
