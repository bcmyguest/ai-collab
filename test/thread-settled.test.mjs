// An active thread with no live session shows as settled; the stored status is never written.
import assert from "node:assert/strict";
import { test } from "node:test";
import { threadRows, threadStatus } from "../web/lib/threads.js";
import { threadGroups } from "../web/lib/thread-groups.ts";

const NOW = 1_800_000_000_000;
const idle = { id: "codex#0000000000000001", online: true };
const gone = { id: "claude#0000000000000002", gone: true };
const offline = { id: "cursor#0000000000000003" };
const waiting = { id: "claude#0000000000000004", online: true, pending: [{ blocking: true }] };

test("threadStatus settles an active thread once no listed session is live", () => {
  assert.equal(threadStatus("active", [gone], NOW), "settled");
  assert.equal(threadStatus(undefined, [gone, offline], NOW), "settled");
  assert.equal(threadStatus("active", [], NOW, 2), "settled", "sessions the server no longer knows");
  assert.equal(threadStatus("active", [idle, gone], NOW), "active", "one live idle session keeps it active");
  assert.equal(threadStatus("active", [], NOW), "active", "a thread with no sessions yet stays active");
  assert.equal(threadStatus("active", [waiting, gone], NOW), "waiting");
  for (const stored of ["snoozed", "archived", "settled"]) assert.equal(threadStatus(stored, [gone], NOW), stored);
});

test("threadRows and threadGroups count listed sessions the server no longer knows", () => {
  const threads = [
    { id: "th_old", status: "active", sessions: ["claude#00000000000000ff"] },
    { id: "th_live", status: "active", sessions: [idle.id, "claude#00000000000000ff"] },
    { id: "th_pin", status: "active", pinned: true, sessions: [gone.id] },
    { id: "th_snooze", status: "snoozed", sessions: [gone.id] },
    { id: "th_new", status: "active", sessions: [] },
  ];
  assert.deepEqual(threadRows(threads, [idle, gone], NOW).map(row => [row.id, row.status, row.stored]), [
    ["th_old", "settled", "active"], ["th_live", "active", "active"], ["th_pin", "settled", "active"], ["th_snooze", "snoozed", "snoozed"], ["th_new", "active", "active"],
  ]);
  const groups = threadGroups(threads, [idle, gone], NOW);
  assert.deepEqual(Object.fromEntries(Object.entries(groups).map(([id, rows]) => [id, rows.map(row => row.id)])), {
    pinned: ["th_pin"], waiting: [], working: [], active: ["th_live", "th_new"], settled: ["th_old"], snoozed: ["th_snooze"], archived: [],
  });
});
