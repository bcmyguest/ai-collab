import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionCounts } from "../web/lib/session-state.js";

test("online sessions count as running, the rest as inactive", () => {
  assert.deepEqual(sessionCounts([{ online: true }, { online: false }, { online: true }, { online: false }, { online: false }]), { running: 2, inactive: 3 });
});

test("a project with no sessions counts zero running and zero inactive", () => {
  assert.deepEqual(sessionCounts([]), { running: 0, inactive: 0 });
});
