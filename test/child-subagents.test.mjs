import assert from "node:assert/strict";
import { test } from "node:test";
import { childRuns } from "../web/lib/child-subagents.js";

const parent = { id: "claude#28d7fa484e39f900", harness: "claude", seenAt: 1_000_000, lastActivityAt: 0, online: true, name: "Parent" };
const child = { id: "codex#0123456789abcdef", parent: parent.id, harness: "codex", seenAt: 5_000, lastActivityAt: 90_000, online: false, folder: "ai-collab" };

test("childRuns lists a child under its parent with its address, harness, folder and activity time", () => {
  const runs = childRuns([parent, child]);
  assert.deepEqual([...runs.keys()], [parent.id]);
  assert.deepEqual(runs.get(parent.id), [{ id: child.id, agent: parent.id, run: child.id, kind: "codex", description: "ai-collab", online: false, time: 90, lastTime: 90, child: true }]);
});

test("childRuns uses the name over the folder and the later of seenAt and lastActivityAt", () => {
  const [entry] = childRuns([parent, { ...child, name: "Fix login", seenAt: 120_000, online: true }]).get(parent.id);
  assert.equal(entry.description, "Fix login");
  assert.equal(entry.time, 120);
  assert.equal(entry.online, true);
});

test("childRuns skips a parent that is not listed and a self-parent", () => {
  assert.equal(childRuns([child]).size, 0);
  assert.equal(childRuns([{ ...child, parent: child.id }]).size, 0);
});
