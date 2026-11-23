// The board's review card and its verdict view, rendered from the real web/app/tasks.jsx with its leaves stubbed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import swc from "next/dist/build/swc/index.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const dependencies = {
  "@/components/ui/badge": { Badge: ({ children }) => createElement("span", null, children) },
  "@/components/ui/button": { Button: ({ children, ...props }) => createElement("button", props, children) },
  "@/lib/utils": { cn: (...parts) => parts.filter(Boolean).join(" ") },
  "@/lib/view-memory": { views: new Map() },
  "@/lib/task-board": {
    ageOf: () => "just now", boardClock: () => 1, columnsOf: list => [["review", list]], countsOf: () => ({}),
    COLUMNS: ["open", "decided", "building", "review", "blocked", "done"], FILTERS: ["all"], statusLabel: (s) => s,
  },
  "../../lib/task-order.mjs": { priorityOf: (task) => task.priority ?? "P2", sortTasks: (list) => list },
  "./outcomes": { OutcomeCards: () => null },
  "./task-graph": { TaskGraph: () => null },
};
await swc.loadBindings();
const { code } = await swc.transform(readFileSync(new URL("../web/app/tasks.jsx", import.meta.url), "utf8"), {
  jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
  module: { type: "commonjs" },
});
const exports = {};
new Function("require", "exports", code)((id) => dependencies[id] ?? require(id), exports);
const { TaskBoard } = exports;

const packet = {
  submission: "sub-1", commit: "739a5300e46bf0f7f12304fd97ad4153e73687d8", base: "6".repeat(40), branch: "builder/smoke-task",
  criteria: "Add one line to notes.md.", check: { code: 0, text: "" },
  files: [{ path: "notes.md", insertions: 1, deletions: 0 }], insertions: 1, deletions: 0, more: 0, at: 1,
  stale: false, diff: "/api/review-diff?project=demo&id=smoke-task&submission=sub-1",
};
const board = { tasks: [{ id: "smoke-task", title: "Smoke task", status: "review", blockers: [], last: { at: 1, text: "1 commit(s)" }, review: packet }] };
const render = (props = {}) => renderToStaticMarkup(createElement(TaskBoard, {
  project: "demo", board, now: 1000, open: () => {}, compose: () => {}, decide: () => {}, taskId: null, back: () => {},
  inspect: () => {}, move: () => {}, ...props,
}));

test("a review card shows the commit, the size of the change and that it waits for the operator", () => {
  const html = render();
  assert.match(html, />739a530</);
  assert.match(html, /\+1/);
  assert.match(html, />1 file</);
  assert.match(html, /waiting for you/);
});

test("a review whose branch has moved says so instead of waiting", () => {
  const html = render({ board: { tasks: [{ ...board.tasks[0], review: { ...packet, stale: true } }] } });
  assert.match(html, /branch moved/);
  assert.doesNotMatch(html, /waiting for you/);
});

test("the task view offers accept and return, and return carries the packet and its note", () => {
  const html = render({ review: () => {}, taskId: "smoke-task" });
  assert.match(html, /Asked for: Add one line to notes\.md\./);
  assert.match(html, /View the diff/);
  assert.match(html, /739a5300e46b<\/span> on <span class="font-mono">builder\/smoke-task<\/span>/);
  assert.match(html, /Accept build/);
  assert.match(html, /What should change\?/);
  assert.doesNotMatch(html, /Returned by/);
});

test("an already decided packet shows the verdict and no buttons", () => {
  const decided = { ...packet, decision: { action: "return", at: 2, by: "operator", note: "Cover the empty case too." } };
  const html = render({ review: () => {}, taskId: "smoke-task", board: { tasks: [{ ...board.tasks[0], review: decided }] } });
  assert.match(html, /Returned by/);
  assert.match(html, /Cover the empty case too\./);
  assert.doesNotMatch(html, /Accept build/);
});

test("a stale packet cannot be decided, so it offers no verdict buttons", () => {
  const html = render({ review: () => {}, taskId: "smoke-task", board: { tasks: [{ ...board.tasks[0], review: { ...packet, stale: true } }] } });
  assert.match(html, /branch moved past this commit/);
  assert.doesNotMatch(html, /Accept build/);
  assert.doesNotMatch(html, /What should change\?/);
});
