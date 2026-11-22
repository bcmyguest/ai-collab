import assert from "node:assert/strict";
import { test } from "node:test";
import { COLUMNS, FILTERS, ageOf, boardClock, columnsOf, countsOf } from "../web/lib/task-board.js";

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

test("countsOf counts every status once, without rescanning the list per filter", () => {
  const tasks = [
    { id: "a", status: "open" }, { id: "b", status: "open" }, { id: "c", status: "done" }, { id: "d", status: "blocked" }, { id: "e", status: "bogus" },
  ];
  assert.deepEqual(countsOf(tasks), { open: 2, decided: 0, building: 0, blocked: 1, done: 1 });
  assert.deepEqual(countsOf([]), Object.fromEntries(COLUMNS.map((status) => [status, 0])));
});

test("the printed age string only changes at its own unit, so cards above a minute skip most per-second renders", () => {
  const at = 1_800_000_000_000;
  // Under a minute the age prints seconds, so it does move each second; that card has to re-render anyway.
  assert.notEqual(ageOf(at, at + 5_000), ageOf(at, at + 6_000));
  // A minute, hour or day string is stable for every whole second inside its unit, which is the win: one render, not 60.
  for (const offset of [5 * 60_000, 3 * 3_600_000, 2 * 86_400_000]) {
    const first = ageOf(at, at + offset);
    for (let tick = 1; tick < 59; tick++) assert.equal(ageOf(at, at + offset + tick * 1000), first, `${offset} + ${tick}s`);
  }
});

test("boardClock stays exact while coarsening: seconds tick, then it holds for the whole printed unit", () => {
  const at = 1_800_000_000_000;
  // A card a few seconds old keeps the clock on the real time, since its age prints seconds.
  assert.equal(boardClock([{ last: { at: at - 5_000 } }], at), at);
  // No card under a minute: the clock lands on the minute and does not move inside it.
  const minuteOld = [{ last: { at: at - 5 * 60_000 } }];
  const coarse = boardClock(minuteOld, at);
  assert.equal(coarse % 60_000, 0, "rounded to the minute");
  assert.equal(ageOf(minuteOld[0].last.at, coarse), ageOf(minuteOld[0].last.at, at), "the printed age is unchanged");
  assert.equal(boardClock(minuteOld, at + 10_000), coarse, "the same minute is the same clock");
  // The finest card decides: an hour-old card alone rounds to the hour.
  assert.equal(boardClock([{ last: { at: at - 3 * 3_600_000 } }], at) % 3_600_000, 0);
  // A card with no progress line does not force a finer clock.
  assert.equal(boardClock([{ last: null }, { last: { at: at - 2 * 86_400_000 } }], at) % 86_400_000, 0);
});
