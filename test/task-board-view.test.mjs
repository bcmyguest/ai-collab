import assert from "node:assert/strict";
import { test } from "node:test";
import { COLUMNS, FILTERS, ageOf, columnsOf } from "../web/lib/task-board.js";

test("columns follow the status order and a filter keeps one column", () => {
  const tasks = [
    { id: "a", status: "done" }, { id: "b", status: "open" }, { id: "c", status: "open" }, { id: "d", status: "blocked" },
  ];
  assert.deepEqual(columnsOf(tasks).map(([status]) => status), COLUMNS);
  assert.deepEqual(columnsOf(tasks).map(([, list]) => list.map(task => task.id)), [["b", "c"], [], [], ["d"], ["a"]]);
  assert.deepEqual(columnsOf(tasks, "open"), [["open", [tasks[1], tasks[2]]]]);
  assert.deepEqual(FILTERS, ["all", ...COLUMNS]);
});

test("ages use the largest whole unit and never go negative", () => {
  const now = 10_000_000;
  assert.equal(ageOf(now - 12_000, now), "12s");
  assert.equal(ageOf(now - 5 * 60_000, now), "5m");
  assert.equal(ageOf(now - 3 * 3_600_000 - 59_000, now), "3h");
  assert.equal(ageOf(now - 2 * 86_400_000, now), "2d");
  assert.equal(ageOf(now + 5000, now), "0s");
});
