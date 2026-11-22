import assert from "node:assert/strict";
import { test } from "node:test";
import { activeAgents } from "../web/lib/activity-rows.js";

const NOW = 1_800_000_000_000;
const sec = (ms) => (NOW - ms) / 1000;

test("the session with an open tool call and each running subagent are active; finished runs are not", () => {
  const rows = [
    { id: "t1", type: "tool_call", agent: "claude#main", time: sec(30_000), tool: "Bash", input: "{}" },
    { id: "r1", type: "subagent", agent: "claude#main", run: "r1", kind: "Explore", time: sec(60_000), lastTime: sec(60_000), done: false, open: false },
    { id: "r2", type: "subagent", agent: "codex#x", run: "r2", kind: "Plan", time: sec(60_000), lastTime: sec(60_000), done: true, open: false },
  ];
  assert.deepEqual(activeAgents(rows, NOW), [
    { key: "claude#main", agent: "claude#main", kind: "" },
    { key: "r1", agent: "claude#main", kind: "Explore" },
  ]);
});

test("a closed tool call makes no session active", () => {
  const rows = [{ id: "t1", type: "tool_call", agent: "claude#main", time: sec(30_000), tool: "Bash", input: "{}", result: { output: "ok" } }];
  assert.deepEqual(activeAgents(rows, NOW), []);
});
