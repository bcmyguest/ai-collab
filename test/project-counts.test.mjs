import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionCounts } from "../web/lib/session-state.js";

test("a live turn counts as running and an idle process counts as off", () => {
  const now = 1_800_000_000_000;
  assert.deepEqual(sessionCounts([
    { online: true, lastActivityAt: now - 1000 },
    { online: true },
    { online: false },
  ], now), { running: 1, inactive: 2 });
});

test("a project with no sessions counts zero running and zero inactive", () => {
  assert.deepEqual(sessionCounts([]), { running: 0, inactive: 0 });
});
