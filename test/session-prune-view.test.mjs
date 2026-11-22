// The session list folds dead cards (offline a day or more) out of Offline into their own section, behind one tap.
// Every card stays reachable; only the fold is silent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deadSplit } from "../web/lib/session-dead.js";
import { DEAD_MS, isDead, lastSeenAt, sessionTree } from "../web/lib/session-state.js";

const NOW = 1_800_000_000_000;
const card = (id, extra) => ({ id, project: "demo", ...extra });

test("a card offline for a day is dead; a fresh offline one and a live one are not", () => {
  const tree = sessionTree([
    card("claude#dead", { seenAt: NOW - DEAD_MS - 1 }),
    card("claude#fresh", { online: false, seenAt: NOW - 60_000 }),
    card("claude#live", { online: true, seenAt: NOW - DEAD_MS * 4 }),
  ], NOW);
  const by = new Map(tree.map(node => [node.id, node]));
  assert.equal(isDead(by.get("claude#dead"), NOW), true, "offline past the day");
  assert.equal(isDead(by.get("claude#fresh"), NOW), false, "offline for a minute");
  assert.equal(isDead(by.get("claude#live"), NOW), false, "online however long it has been quiet");
  assert.equal(isDead(by.get("claude#dead"), NOW - DEAD_MS + 1), false, "just under a day");

  const [offline, dead] = deadSplit(tree, NOW);
  assert.deepEqual(offline.map(node => node.id), ["claude#fresh"]);
  assert.deepEqual(dead.map(node => node.id), ["claude#dead"]);
});

test("deadSplit keeps a working card out of the Dead section and splits nothing when none is dead", () => {
  const tree = sessionTree([
    card("codex#busy", { online: true, lastActivityAt: NOW - 1000 }),
    card("codex#fresh", { online: false, seenAt: NOW - 1000 }),
  ], NOW);
  assert.deepEqual(deadSplit(tree, NOW), [tree.filter(node => node.group === "offline"), []]);
});

test("a child's activity keeps its parent card out of the dead list", () => {
  const parent = card("claude#1", { seenAt: NOW - DEAD_MS * 2 });
  const child = card("codex#2", { parent: "claude#1", seenAt: NOW - 60_000 });
  const node = sessionTree([parent, child], NOW).find(item => item.id === "claude#1");
  assert.equal(lastSeenAt(node), NOW - 60_000);
  assert.equal(isDead(node, NOW), false);
  assert.equal(isDead({ ...node, children: [] }, NOW), true);
  assert.deepEqual(deadSplit([node], NOW)[0].map(item => item.id), ["claude#1"]);
});
