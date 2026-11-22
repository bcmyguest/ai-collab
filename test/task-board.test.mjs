import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { addProgress, addTask, ownTask, writeTasks } from "../lib/tasks.mjs";
import { taskBoard } from "../web/server/task-board.mjs";

const NOW = Date.parse("2026-11-22T00:00:00Z");
const OWNER = "claude#0123456789abcdef";

test("taskBoard lists tasks with owner presence, run and the last progress line", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "task-board-"));
  const doc = { v: 1, tasks: [] };
  addTask(doc, { id: "one", title: "One", status: "building" }, NOW);
  ownTask(doc, "one", OWNER, NOW);
  addProgress(doc, "one", { by: OWNER, text: "first" }, NOW + 1);
  addProgress(doc, "one", { by: OWNER, text: "second" }, NOW + 2);
  doc.tasks[0].run = "lx9k2m-abc123";
  addTask(doc, { id: "two", title: "Two", status: "blocked" }, NOW);
  doc.tasks[1].blockers.push("one");
  writeTasks(root, doc);

  const board = taskBoard(root, [{ id: OWNER, online: true }]);
  assert.equal(board.error, undefined);
  assert.deepEqual(board.tasks[0], {
    id: "one", title: "One", status: "building", blockers: [], owner: OWNER, ownerOnline: true, run: "lx9k2m-abc123",
    last: { at: NOW + 2, by: OWNER, text: "second" }, updated: NOW + 2,
  });
  assert.deepEqual(board.tasks[1], { id: "two", title: "Two", status: "blocked", blockers: ["one"], last: null, updated: NOW });
});

test("taskBoard marks an owner not seen as offline and reports an invalid store", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "task-board-"));
  const doc = { v: 1, tasks: [] };
  addTask(doc, { id: "one", title: "One" }, NOW);
  ownTask(doc, "one", OWNER, NOW);
  writeTasks(root, doc);
  assert.equal(taskBoard(root, []).tasks[0].ownerOnline, false);
  assert.deepEqual(taskBoard(""), { tasks: [] });

  const broken = mkdtempSync(path.join(os.tmpdir(), "task-board-"));
  mkdirSync(path.join(broken, ".ai-collab"));
  writeFileSync(path.join(broken, ".ai-collab", "tasks.json"), "{");
  assert.match(taskBoard(broken).error, /invalid JSON/);
  assert.deepEqual(taskBoard(broken).tasks, []);
});
