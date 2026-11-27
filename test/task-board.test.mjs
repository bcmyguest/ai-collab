import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { addProgress, addTask, createFileBackend, ownTask, writeStore } from "../lib/tasks.ts";
import { taskBoard } from "../web/server/task-board.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const NOW = Date.parse("2026-11-22T00:00:00Z");
const OWNER = "claude#0123456789abcdef";

function backendWith(build) {
  const file = path.join(tempDir({ after }, "task-board-"), "demo.json");
  const doc = { v: 1, tasks: [] };
  build(doc);
  writeStore(file, doc);
  return createFileBackend(file);
}

test("taskBoard lists tasks with owner presence, run and the last progress line", () => {
  const backend = backendWith((doc) => {
    addTask(doc, { id: "one", title: "One", status: "building" }, NOW);
    ownTask(doc, "one", OWNER, NOW);
    addProgress(doc, "one", { by: OWNER, text: "first" }, NOW + 1);
    addProgress(doc, "one", { by: OWNER, text: "second" }, NOW + 2);
    doc.tasks[0].run = "lx9k2mabc123";
    addTask(doc, { id: "two", title: "Two", status: "blocked" }, NOW);
    doc.tasks[1].blockers.push("one");
  });

  const board = taskBoard(backend, [{ id: OWNER, online: true }]);
  assert.equal(board.error, undefined);
  assert.deepEqual(board.tasks[0], {
    id: "one", title: "One", status: "building", blockers: [], owner: OWNER, ownerOnline: true, run: "lx9k2mabc123",
    last: { at: NOW + 2, by: OWNER, text: "second" }, updated: NOW + 2,
  });
  assert.deepEqual(board.tasks[1], { id: "two", title: "Two", status: "blocked", blockers: ["one"], last: null, updated: NOW });
});

test("taskBoard names the active session of a task's team run", () => {
  const backend = backendWith((doc) => {
    addTask(doc, { id: "run-task", title: "Run task" }, NOW);
    doc.tasks[0].run = "lx9k2mabc123";
  });
  const runs = [{ id: "lx9k2mabc123", active: "reviewer", sessions: { lead: "claude#1122334455667788", reviewer: OWNER } }];
  assert.equal(taskBoard(backend, [], runs).tasks[0].runSession, OWNER);
  assert.equal(taskBoard(backend, [], []).tasks[0].runSession, undefined);
});

test("taskBoard marks an owner not seen as offline and reports an invalid store", (t) => {
  const backend = backendWith((doc) => {
    addTask(doc, { id: "one", title: "One" }, NOW);
    ownTask(doc, "one", OWNER, NOW);
  });
  assert.equal(taskBoard(backend, []).tasks[0].ownerOnline, false);
  assert.deepEqual(taskBoard(null), { tasks: [] });

  const broken = path.join(tempDir(t, "task-board-"), "demo.json");
  writeFileSync(broken, "{");
  assert.match(taskBoard(createFileBackend(broken)).error, /invalid JSON/);
  assert.deepEqual(taskBoard(createFileBackend(broken)).tasks, []);
});

test("taskBoard uses a live linked session when the task has no explicit owner", () => {
  const backend = backendWith(doc => addTask(doc, { id: "handoff", title: "Handoff" }, NOW));
  const agents = [{ id: OWNER, online: true }];
  const session = { address: OWNER, taskId: "handoff", status: "running", createdAt: NOW };
  assert.equal(taskBoard(backend, agents, [], [session]).tasks[0].owner, OWNER);
  assert.equal(taskBoard(backend, agents, [], [{ ...session, status: "ended" }]).tasks[0].owner, undefined);
});
