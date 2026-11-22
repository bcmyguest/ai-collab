import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  addProgress, addTask, blockTask, importFeatureRequests, ownTask, readTasks, renderFeatureRequests,
  setTaskField, slugify, tasksFile, validateTasks, writeTasks,
} from "../lib/tasks.mjs";

const NOW = Date.parse("2026-11-22T00:00:00Z");
const ADDRESS = "claude#0123456789abcdef";
const FIXTURE = `# Feature requests

Intro line.

| Request | Status |
|---|---|
| Session menu | done (merged and deployed) |
| Teams: dynamic | done; operator 2026-11-21 |
| Cursor sandbox | building (operator yes) |
| Reviews | adopted for reviews |
| Pending idea | open |
| Escaped \\| pipe | decided |
`;

function task(fields) {
  return { id: "a", title: "A", status: "open", blockers: [], progress: [], created: NOW, updated: NOW, ...fields };
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "tasks-"));
}

test("validateTasks accepts a well-formed document with blockers and an owner", () => {
  const doc = {
    v: 1,
    tasks: [
      task({ id: "a" }),
      task({ id: "b", status: "blocked", blockers: ["a"], owner: ADDRESS, run: "lx9k2m-abc123", detail: "d", progress: [{ at: NOW, by: "claude", text: "step" }] }),
    ],
  };
  assert.equal(validateTasks(doc), doc);
});

test("validateTasks rejects each invalid field with the task id", () => {
  const bad = [
    [task({ status: "started" }), /task a: invalid status/],
    [task({ id: "Bad Id" }), /task Bad Id: invalid id/],
    [task({ title: "  " }), /task a: invalid title/],
    [task({ owner: "not an address" }), /task a: owner/],
    [task({ blockers: ["a", "a"] }), /task a: blockers/],
    [task({ progress: [{ at: NOW, by: "", text: "x" }] }), /task a: progress/],
    [task({ created: "yesterday" }), /task a: created/],
  ];
  for (const [t, pattern] of bad) assert.throws(() => validateTasks({ v: 1, tasks: [t] }), pattern);
});

test("validateTasks rejects duplicate ids, unknown blockers, self blockers and cycles", () => {
  assert.throws(() => validateTasks({ v: 1, tasks: [task({ id: "a" }), task({ id: "a" })] }), /duplicate id/);
  assert.throws(() => validateTasks({ v: 1, tasks: [task({ blockers: ["zz"] })] }), /blocker zz is not a task/);
  assert.throws(() => validateTasks({ v: 1, tasks: [task({ blockers: ["a"] })] }), /blocks itself/);
  assert.throws(() => validateTasks({ v: 1, tasks: [task({ id: "a", blockers: ["b"] }), task({ id: "b", blockers: ["a"] })] }), /blocker cycle/);
  assert.throws(() => validateTasks({ v: 2, tasks: [] }), /expected/);
});

test("readTasks reads a missing file as no tasks and refuses an invalid one", () => {
  const root = tempRoot();
  assert.deepEqual(readTasks(root), { v: 1, tasks: [] });
  const file = tasksFile(root);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "{not json");
  assert.throws(() => readTasks(root), /invalid JSON/);
  writeFileSync(file, JSON.stringify({ v: 1, tasks: [task({ status: "nope" })] }));
  assert.throws(() => readTasks(root), (err) => err.message.startsWith(`${file}: task a: invalid status`));
});

test("writeTasks writes atomically and round-trips through readTasks", () => {
  const root = tempRoot();
  const doc = { v: 1, tasks: [] };
  addTask(doc, { title: "First task", status: "decided" }, NOW);
  writeTasks(root, doc);
  assert.deepEqual(readTasks(root), doc);
  assert.deepEqual(readdirSync(join(root, ".ai-collab")), ["tasks.json"]);
  assert.throws(() => writeTasks(root, { v: 1, tasks: [task({ status: "x" })] }), /invalid status/);
  assert.deepEqual(readTasks(root), doc);
});

test("slugify and addTask make unique short ids", () => {
  assert.equal(slugify("Teams: dynamic, stored!"), "teams-dynamic-stored");
  assert.equal(slugify("***"), "task");
  assert.ok(slugify("x".repeat(80)).length <= 40);
  const doc = { v: 1, tasks: [] };
  assert.equal(addTask(doc, { title: "Same title" }, NOW).id, "same-title");
  assert.equal(addTask(doc, { title: "Same title" }, NOW).id, "same-title-2");
  assert.throws(() => addTask(doc, { id: "same-title", title: "Again" }, NOW), /exists/);
});

test("setTaskField, blockTask, ownTask and addProgress update one task", () => {
  const doc = { v: 1, tasks: [] };
  addTask(doc, { id: "a", title: "A" }, NOW);
  addTask(doc, { id: "b", title: "B" }, NOW);
  setTaskField(doc, "a", "status", "building", NOW + 1);
  blockTask(doc, "a", "b", NOW + 2);
  blockTask(doc, "a", "b", NOW + 2);
  ownTask(doc, "a", ADDRESS, NOW + 3);
  addProgress(doc, "a", { by: ADDRESS, text: "  tests green  " }, NOW + 4);
  const a = doc.tasks[0];
  assert.deepEqual([a.status, a.blockers, a.owner, a.updated], ["building", ["b"], ADDRESS, NOW + 4]);
  assert.deepEqual(a.progress, [{ at: NOW + 4, by: ADDRESS, text: "tests green" }]);
  assert.throws(() => setTaskField(doc, "a", "status", "started", NOW), /invalid status/);
  assert.throws(() => setTaskField(doc, "a", "created", 1, NOW), /cannot set created/);
  assert.throws(() => ownTask(doc, "zz", ADDRESS, NOW), /no task zz/);
});

test("importFeatureRequests takes the status from the first word and the rest as detail", () => {
  const doc = importFeatureRequests(FIXTURE, NOW);
  const byTitle = Object.fromEntries(doc.tasks.map((t) => [t.title, t]));
  assert.deepEqual(
    [byTitle["Session menu"].status, byTitle["Session menu"].detail],
    ["done", "(merged and deployed)"],
  );
  assert.deepEqual([byTitle["Teams: dynamic"].status, byTitle["Teams: dynamic"].detail], ["done", "; operator 2026-11-21"]);
  assert.deepEqual([byTitle["Cursor sandbox"].status, byTitle["Cursor sandbox"].detail], ["building", "(operator yes)"]);
  assert.equal(byTitle["Pending idea"].detail, undefined);
  // A first word that is no status keeps the whole cell as detail under open.
  assert.deepEqual([byTitle.Reviews.status, byTitle.Reviews.detail], ["open", "adopted for reviews"]);
  assert.equal(byTitle["Escaped | pipe"].status, "decided");
  assert.deepEqual(doc.tasks.map((t) => t.id), ["session-menu", "teams-dynamic", "cursor-sandbox", "reviews", "pending-idea", "escaped-pipe"]);
  assert.equal(doc.tasks[0].created, NOW);
});

test("renderFeatureRequests keeps the table layout and rows of the import", () => {
  const out = renderFeatureRequests(importFeatureRequests(FIXTURE, NOW));
  const rows = (text) => text.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Request"));
  assert.deepEqual(rows(out), [
    "| Session menu | done (merged and deployed) |",
    "| Teams: dynamic | done; operator 2026-11-21 |",
    "| Cursor sandbox | building (operator yes) |",
    "| Reviews | open adopted for reviews |",
    "| Pending idea | open |",
    "| Escaped \\| pipe | decided |",
  ]);
  assert.match(out, /^# Feature requests\n/);
  assert.ok(out.includes("| Request | Status |\n|---|---|\n"));
});

test("the repo's feature-requests.md is rendered from its .ai-collab/tasks.json", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const expected = renderFeatureRequests(readTasks(root));
  assert.equal(readFileSync(join(root, "docs", "feature-requests.md"), "utf8"), expected);
  assert.ok(existsSync(tasksFile(root)));
});
