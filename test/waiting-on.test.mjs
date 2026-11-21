import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionState, sessionTree, waitingOn } from "../web/lib/session-state.js";

const NOW = 1_000_000;
const online = { id: "claude#1", online: true };

test("waitingOn counts only open blocking items", () => {
  assert.equal(waitingOn([{ blocking: true }], NOW), true);
  assert.equal(waitingOn([{ blocking: true, expiresAt: NOW + 1 }], NOW), true);
  assert.equal(waitingOn([{ blocking: true, expiresAt: NOW - 1 }], NOW), false, "an expired approval does not wait");
  assert.equal(waitingOn([{ blocking: false }], NOW), false, "a plain question does not wait");
  assert.equal(waitingOn(undefined, NOW), false);
});

test("sessionState and waitingOn agree", () => {
  const pending = [[{ blocking: true }], [{ blocking: false }], []];
  for (const list of pending) {
    assert.equal(sessionState({ ...online, pending: list }, NOW) === "waiting", waitingOn(list, NOW));
  }
});

test("sessionTree lists waiting sessions first across projects", () => {
  const sessions = [
    { id: "codex#1", project: "b", online: true, seenAt: NOW },
    { id: "claude#1", project: "a", online: true, seenAt: NOW - 5, pending: [{ blocking: true }] },
    { id: "claude#2", project: "a", online: true, seenAt: NOW, lastActivityAt: NOW - 1000 },
  ];
  const roots = sessionTree(sessions, NOW);
  assert.deepEqual(roots.map(node => [node.id, node.group]), [["claude#1", "waiting"], ["claude#2", "working"], ["codex#1", "idle"]]);
});
