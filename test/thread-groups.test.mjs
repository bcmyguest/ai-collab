import assert from "node:assert/strict";
import { test } from "node:test";
import { elapsed, shortName, threadGroups, threadSession, unthreaded, workingTime } from "../web/lib/thread-groups.ts";

const NOW = 1_800_000_000_000;

test("threads land in one group each: archived and snoozed win over pinned, a waiting session beats the stored status", () => {
  const agents = [
    { id: "claude#aaaaaaaaaaaa", peer: "claude", pending: [{ id: "q1", blocking: true, expiresAt: NOW + 60_000 }] },
    { id: "codex#bbbbbbbbbbbb", peer: "codex", openCallAt: NOW - 90_000 },
  ];
  const groups = threadGroups([
    { id: "th_1", status: "archived", pinned: true },
    { id: "th_2", status: "snoozed" },
    { id: "th_3", pinned: true, updatedAt: 1 },
    { id: "th_4", status: "settled", sessions: ["claude#aaaaaaaaaaaa"] },
    { id: "th_5", sessions: ["codex#bbbbbbbbbbbb"] },
    { id: "th_6", status: "settled" },
    { id: "th_7", pinned: true, updatedAt: 2 },
  ], agents, NOW);
  assert.deepEqual(Object.fromEntries(Object.entries(groups).map(([id, rows]) => [id, rows.map(row => row.id)])), {
    pinned: ["th_7", "th_3"], waiting: ["th_4"], working: ["th_5"], active: [], settled: ["th_6"], snoozed: ["th_2"], archived: ["th_1"],
  });
  assert.deepEqual(groups.working[0].harnesses, ["codex"]);
});

test("a working thread's time runs from its oldest open tool call", () => {
  const [row] = threadGroups([{ id: "th_1", sessions: ["a#1", "b#2"] }], [
    { id: "a#1", openCallAt: NOW - 5 * 60_000 }, { id: "b#2", openCallAt: NOW - 2 * 60_000 },
  ], NOW).working;
  assert.equal(workingTime(row, NOW), "5m");
  const [idle] = threadGroups([{ id: "th_2", sessions: [] }], [], NOW).active;
  assert.equal(workingTime(idle, NOW), "");
});

test("a thread opens its lead session while it has a card, else its first known session", () => {
  const thread = { id: "th_1", leadSession: "a#1", sessions: ["a#1", "b#2"] };
  assert.equal(threadSession(thread, [{ id: "a#1" }, { id: "b#2" }]), "a#1");
  assert.equal(threadSession(thread, [{ id: "b#2" }]), "b#2");
  assert.equal(threadSession(thread, []), "a#1");
});

test("sessions outside every thread stay listed; gone ones drop out", () => {
  const agents = [{ id: "a#1" }, { id: "b#2" }, { id: "c#3", gone: true }];
  assert.deepEqual(unthreaded(agents, [{ id: "th_1", sessions: ["a#1"] }]).map(agent => agent.id), ["b#2"]);
});

test("short names prefer the identity, keep five words and cap at forty characters", () => {
  assert.equal(shortName({ id: "a#1", identityName: "Reviewer", name: "Review the PR" }), "Reviewer");
  assert.equal(shortName({ id: "a#1", name: "fix the flaky sync test in the runner" }), "fix the flaky sync test…");
  assert.equal(shortName(undefined, "Thread title"), "Thread title");
  assert.equal(shortName({ id: "a#1", name: "x".repeat(60) }).length, 40);
});

test("elapsed time is compact", () => {
  assert.deepEqual([45_000, 12 * 60_000, 3 * 3_600_000, 2 * 86_400_000].map(elapsed), ["45s", "12m", "3h", "2d"]);
});
