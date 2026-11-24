import { test } from "node:test";
import assert from "node:assert/strict";
import { diffScreens, formatDiff, normalizeScreen } from "../tools/screen-state.mjs";

test("normalizeScreen drops ages and clock times", () => {
  assert.deepEqual(normalizeScreen("Tasks\nUpdated 3 min ago\n12:04\n"), ["Tasks", "Updated AGE", "CLOCK"]);
});

test("diffScreens names only the screens whose lines changed", () => {
  const before = { home: ["Home"], tasks: ["Board", "Open"] };
  const after = { home: ["Home"], tasks: ["Board", "Ready"] };
  const changes = diffScreens(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].screen, "tasks");
  assert.deepEqual(changes[0].removed, ["Open"]);
  assert.deepEqual(changes[0].added, ["Ready"]);
  assert.match(formatDiff(changes), /tasks changed/);
  assert.equal(formatDiff(diffScreens(before, before)), "no screen changed");
});
