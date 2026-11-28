// Archive inactive (docs/threads.md "Sidebar"): threads untouched for 24 h whose sessions are all offline, ended or gone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { INACTIVE_MS, inactiveThreads } from "../web/lib/thread-groups.ts";

const NOW = 1_800_000_000_000;
const OLD = NOW - INACTIVE_MS - 1;

test("archive inactive takes old threads with no online or live session and leaves the rest", () => {
  const agents = [
    { id: "a#1", online: true },
    { id: "b#2", online: false },
    { id: "c#3", online: false, lastActivityAt: NOW - 10_000 },
    { id: "d#4", online: true, gone: true },
  ];
  const threads = [
    { id: "th_online", updatedAt: OLD, sessions: ["a#1", "b#2"] },
    { id: "th_offline", updatedAt: OLD, sessions: ["b#2"] },
    { id: "th_working", updatedAt: OLD, sessions: ["c#3"] },
    { id: "th_unknown", updatedAt: OLD, sessions: ["e#5"] },
    { id: "th_gone", updatedAt: OLD, sessions: ["d#4"] },
    { id: "th_empty", updatedAt: OLD, sessions: [] },
    { id: "th_recent", updatedAt: NOW - INACTIVE_MS + 60_000, sessions: ["b#2"] },
    { id: "th_archived", status: "archived", updatedAt: OLD, sessions: ["b#2"] },
    { id: "th_snoozed", status: "snoozed", updatedAt: OLD, sessions: ["b#2"] },
  ];
  assert.deepEqual(inactiveThreads(threads, agents, NOW).map((t) => t.id), ["th_offline", "th_unknown", "th_gone", "th_empty", "th_snoozed"]);
});
