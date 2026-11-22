import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  PROGRESS_MAX, TABLE_END, TABLE_START, addTask, clipProgress, createFileBackend, importFeatureRequests,
  readStore, renderFeatureRequests, importReport, slugify, taskStoreFile, validateTasks, writeStore,
} from "../lib/tasks.mjs";

const NOW = Date.parse("2026-11-22T00:00:00Z");
const ADDRESS = "claude#0123456789abcdef";
const RUN = "lx9k2mabc123";
const FIXTURE = `# Feature requests

Intro line.

${TABLE_START}
| Request | Status |
|---|---|
| Session menu | done (merged and deployed) |
| Teams: dynamic | done; operator 2026-11-21 |
| Cursor sandbox | building (operator yes) |
| Reviews | adopted for reviews |
| Pending idea | open |
| Escaped \\| pipe | decided |
| Ahead of plan | building-ish |
${TABLE_END}

Outro line.
`;

function task(fields) {
  return { id: "a", title: "A", status: "open", blockers: [], progress: [], created: NOW, updated: NOW, ...fields };
}

function tempFile(name = "tasks.json") {
  return join(mkdtempSync(join(tmpdir(), "tasks-")), name);
}

test("validateTasks accepts a well-formed document with blockers, owner and run", () => {
  const doc = {
    v: 1,
    tasks: [
      task({ id: "a" }),
      task({ id: "b", status: "blocked", blockers: ["a"], owner: ADDRESS, run: RUN, detail: "d", progress: [{ at: NOW, by: "claude", text: "step" }] }),
    ],
  };
  assert.equal(validateTasks(doc), doc);
});

test("validateTasks rejects each invalid field with the task id", () => {
  const bad = [
    [task({ status: "started" }), /task a: invalid status/],
    [task({ id: "Bad Id" }), /task Bad Id: invalid id/],
    [task({ title: "  " }), /task a: invalid title/],
    [task({ title: "two\nlines" }), /task a: invalid title/],
    [task({ detail: "x\r\ny" }), /task a: invalid detail/],
    [task({ owner: "not an address" }), /task a: owner/],
    [task({ run: "lx9k2m-abc123" }), /task a: invalid run id/],
    [task({ blockers: ["a", "a"] }), /task a: blockers/],
    [task({ progress: [{ at: NOW, by: "", text: "x" }] }), /task a: progress/],
    [task({ progress: [{ at: NOW, by: "claude", text: "x".repeat(PROGRESS_MAX + 1) }] }), /task a: progress/],
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

test("readStore reads a missing file as no tasks and refuses an invalid one", () => {
  const file = tempFile();
  assert.deepEqual(readStore(file), { v: 1, tasks: [] });
  writeFileSync(file, "{not json");
  assert.throws(() => readStore(file), /invalid JSON/);
  writeFileSync(file, JSON.stringify({ v: 1, tasks: [task({ status: "nope" })] }));
  assert.throws(() => readStore(file), (err) => err.message.startsWith(`${file}: task a: invalid status`));
});

test("writeStore writes atomically and round-trips through readStore", () => {
  const file = tempFile();
  const doc = { v: 1, tasks: [] };
  addTask(doc, { title: "First task", status: "decided" }, NOW);
  writeStore(file, doc);
  assert.deepEqual(readStore(file), doc);
  assert.deepEqual(readdirSync(join(file, "..")), ["tasks.json"]);
  assert.throws(() => writeStore(file, { v: 1, tasks: [task({ status: "x" })] }), /invalid status/);
  assert.deepEqual(readStore(file), doc);
});

test("the store lives under XDG_DATA_HOME, then ~/.local/share, one file per project", () => {
  assert.equal(taskStoreFile("demo", { XDG_DATA_HOME: "/x/data" }), "/x/data/ai-collab/tasks/demo.json");
  assert.equal(taskStoreFile("demo", { HOME: "/h" }), "/h/.local/share/ai-collab/tasks/demo.json");
});

test("file backend: add, get, update and addProgress each write the store", async () => {
  const backend = createFileBackend(tempFile());
  assert.deepEqual(backend.list(), []);
  await backend.add({ id: "two", title: "Two" }, NOW);
  await backend.add({ id: "one", title: "One" }, NOW);
  await backend.update("one", { status: "building", owner: ADDRESS, run: RUN, block: "two" }, NOW + 1);
  await backend.addProgress("one", { by: ADDRESS, text: "  tests green  " }, NOW + 2);
  const one = backend.get("one");
  assert.deepEqual([one.status, one.owner, one.run, one.blockers, one.updated], ["building", ADDRESS, RUN, ["two"], NOW + 2]);
  assert.deepEqual(one.progress, [{ at: NOW + 2, by: ADDRESS, text: "tests green" }]);
  assert.throws(() => backend.get("zz"), /no task zz/);
});

test("a patch that fails validation leaves the store unchanged", async () => {
  const backend = createFileBackend(tempFile());
  await backend.add({ id: "one", title: "One" }, NOW);
  const before = backend.list();
  await assert.rejects(backend.update("one", { status: "started" }, NOW), /invalid status/);
  await assert.rejects(backend.update("one", { title: "bad\ntitle" }, NOW), /invalid title/);
  await assert.rejects(backend.update("one", { run: "lx9k2m-abc123" }, NOW), /invalid run id/);
  await assert.rejects(backend.update("one", { created: 1 }, NOW), /cannot set created/);
  assert.deepEqual(backend.list(), before);
});

test("concurrent writers through the lock all land", async () => {
  const file = tempFile();
  const backend = createFileBackend(file);
  await backend.add({ id: "shared", title: "Shared" }, NOW);
  const writes = Array.from({ length: 25 }, (_, i) => backend.addProgress("shared", { by: ADDRESS, text: `note ${i}` }, NOW + i));
  const adds = Array.from({ length: 10 }, (_, i) => backend.add({ id: `task-${i}`, title: `Task ${i}` }, NOW));
  await Promise.all([...writes, ...adds]);
  assert.equal(backend.get("shared").progress.length, 25);
  assert.equal(backend.list().length, 11);
  assert.deepEqual(readdirSync(join(file, "..")).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock")), []);
});

test("a long progress body is clipped to PROGRESS_MAX code points with an ellipsis", async () => {
  const long = "é😀".repeat(400);
  const clipped = clipProgress(long);
  assert.equal(clipped.truncated, true);
  assert.equal([...clipped.text].length, PROGRESS_MAX);
  assert.ok(clipped.text.endsWith("…"));
  assert.deepEqual(clipProgress("short"), { text: "short", truncated: false });
  const backend = createFileBackend(tempFile());
  await backend.add({ id: "one", title: "One" }, NOW);
  await backend.addProgress("one", { by: ADDRESS, text: long }, NOW);
  assert.equal(backend.get("one").progress[0].text, clipped.text);
});

test("titles and details with a line break are rejected", () => {
  assert.throws(() => addTask({ v: 1, tasks: [] }, { title: "one\ntwo" }, NOW), /invalid title/);
  assert.throws(() => addTask({ v: 1, tasks: [] }, { title: "ok", detail: "a\nb" }, NOW), /invalid detail/);
});

test("replaceAll writes into an empty store and refuses an existing one", async () => {
  const file = tempFile();
  const backend = createFileBackend(file);
  const doc = importFeatureRequests(FIXTURE, NOW);
  assert.equal(await backend.replaceAll(doc), doc.tasks.length);
  assert.equal(existsSync(file), true);
  await assert.rejects(backend.replaceAll(doc), /import runs once/);
});

test("import maps the status word exactly and keeps the rest as detail", () => {
  const byTitle = Object.fromEntries(importFeatureRequests(FIXTURE, NOW).tasks.map((t) => [t.title, t]));
  assert.deepEqual([byTitle["Session menu"].status, byTitle["Session menu"].detail], ["done", "(merged and deployed)"]);
  assert.deepEqual([byTitle["Teams: dynamic"].status, byTitle["Teams: dynamic"].detail], ["done", "; operator 2026-11-21"]);
  assert.deepEqual([byTitle["Cursor sandbox"].status, byTitle["Cursor sandbox"].detail], ["building", "(operator yes)"]);
  assert.equal(byTitle["Pending idea"].detail, undefined);
  // A cell with no status word is done, with the whole cell as detail.
  assert.deepEqual([byTitle.Reviews.status, byTitle.Reviews.detail], ["done", "adopted for reviews"]);
  // "building-ish" is no status word: the status word must end the cell or precede a separator.
  assert.deepEqual([byTitle["Ahead of plan"].status, byTitle["Ahead of plan"].detail], ["done", "building-ish"]);
  assert.equal(byTitle["Escaped | pipe"].status, "decided");
  assert.equal(importFeatureRequests(FIXTURE, NOW).tasks[0].created, NOW);
});

test("render keeps the rows and the prose outside the markers", () => {
  const doc = importFeatureRequests(FIXTURE, NOW);
  const out = renderFeatureRequests(doc, FIXTURE);
  assert.ok(out.startsWith("# Feature requests\n\nIntro line.\n\n" + TABLE_START + "\n| Request | Status |\n|---|---|\n"));
  assert.ok(out.endsWith("\n" + TABLE_END + "\n\nOutro line.\n"));
  assert.ok(out.includes("| Session menu | done (merged and deployed) |\n"));
  assert.ok(out.includes("| Escaped \\| pipe | decided |\n"));
  // Without markers, a full document is written.
  const fresh = renderFeatureRequests(doc, "");
  assert.match(fresh, /^# Feature requests\n/);
  assert.ok(fresh.includes(TABLE_START) && fresh.includes(TABLE_END));
});

test("the committed feature-requests.md is the render of its own table", () => {
  const file = fileURLToPath(new URL("../docs/feature-requests.md", import.meta.url));
  const text = readFileSync(file, "utf8");
  assert.equal(renderFeatureRequests(importFeatureRequests(text, NOW), text), text);
  assert.ok(slugify("Teams: dynamic, stored!") === "teams-dynamic-stored");
});

test("render refuses a file with content but no valid marker pair", () => {
  const doc = importFeatureRequests(FIXTURE, NOW);
  assert.throws(() => renderFeatureRequests(doc, "# Prose only\n\n| a | done |\n"), /needs one/);
  assert.throws(() => renderFeatureRequests(doc, `${TABLE_END}\n${TABLE_START}\n`), /needs one/);
  assert.throws(() => renderFeatureRequests(doc, `${TABLE_START}\n${TABLE_START}\n${TABLE_END}\n`), /needs one/);
  assert.match(renderFeatureRequests(doc, ""), /^# Feature requests/);
});

test("import without markers takes the one table and refuses two", () => {
  const one = "# Notes\n\n| Request | Status |\n|---|---|\n| Alpha | open |\n\nMore prose.\n";
  assert.deepEqual(importFeatureRequests(one, NOW).tasks.map((t) => t.title), ["Alpha"]);
  const two = "| Request | Status |\n|---|---|\n| A | open |\n\ntext\n\n| Request | Status |\n|---|---|\n| B | open |\n";
  assert.throws(() => importFeatureRequests(two, NOW), /2 tables/);
  assert.throws(() => importFeatureRequests(`${TABLE_START}\n| Request | Status |\n`, NOW), /unbalanced/);
});

test("import reads status words in any case and dashes set off by spaces", () => {
  const rows = [
    "| Upper | OPEN |",
    "| Dash em | Done — shipped |",
    "| Dash hyphen | Building - in review |",
    "| Glued | decided—later |",
    "| Open ended | open-ended |",
    "| Plain | blocked |",
  ].join("\n");
  const { doc, defaulted } = importReport(`| Request | Status |\n|---|---|\n${rows}\n`, NOW);
  const by = Object.fromEntries(doc.tasks.map((t) => [t.title, [t.status, t.detail]]));
  assert.deepEqual(by.Upper, ["open", undefined]);
  assert.deepEqual(by["Dash em"], ["done", "shipped"]);
  assert.deepEqual(by["Dash hyphen"], ["building", "in review"]);
  assert.deepEqual(by.Glued, ["decided", "later"]);
  // "open-ended" has no separator, so it is no status word and defaults to done with the whole cell.
  assert.deepEqual(by["Open ended"], ["done", "open-ended"]);
  assert.deepEqual(by.Plain, ["blocked", undefined]);
  assert.deepEqual(defaulted, ["Open ended"]);
});

test("a title ending in a backslash round-trips through render and import", () => {
  const doc = { v: 1, tasks: [] };
  addTask(doc, { id: "slash", title: "Path C:\\dir\\", status: "open" }, NOW);
  const rendered = renderFeatureRequests(doc, "");
  // The row escapes each backslash, so the trailing one cannot escape the cell's closing pipe.
  assert.ok(rendered.includes("| Path C:\\\\dir\\\\ | open |"), "the table row doubles the backslashes");
  const back = importFeatureRequests(rendered, NOW);
  assert.equal(back.tasks[0].title, "Path C:\\dir\\");
  assert.equal(renderFeatureRequests(back, rendered), rendered);
});

test("the file backend reports store changes to its watcher and stops on request", async () => {
  const backend = createFileBackend(tempFile());
  let calls = 0;
  const stop = backend.watch(() => { calls++; });
  // watchFile takes its baseline stat asynchronously, so a write before that stat is missed: keep writing until one is seen.
  const until = Date.now() + 15_000;
  for (let n = 0; calls === 0 && Date.now() < until; n++) {
    await backend.add({ id: `watched-${n}`, title: "Watched" }, NOW);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  assert.ok(calls > 0, "the watcher fired after the write");
  stop();
});
