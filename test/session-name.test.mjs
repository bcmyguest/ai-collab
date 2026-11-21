import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionName } from "../lib/names.mjs";

test("a subagent's hook or a worktree label never renames the parent session", () => {
  assert.equal(sessionName("claude", { session_title: "Fix login bug" }), "Fix login bug");
  assert.equal(sessionName("claude", { session_title: "Fix login bug", agent_id: "a3c26b3960e76171e" }), "");
  assert.equal(sessionName("claude", { session_title: "agent-a3c26b3960e76171e" }), "");
  assert.equal(sessionName("opencode", { session_title: "Agent-3e11dc94" }), "");
});
