// A skipped decision reads "Skipped" on its card and surface; the decision queue offers Skip on every row except a suspended run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import swc from "next/dist/build/swc/index.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { approvalOutcome, approvalOperations, surfaceOf } from "../web/lib/a2ui.js";

const ID = "abcdefabcdef";
const components = (operations) => operations.find((op) => op.updateComponents).updateComponents.components;

test("a skipped approval and a skipped choice show Skipped without buttons", () => {
  const permission = { id: ID, harness: "claude", tool: "Bash", summary: "make", expiresAt: 0, state: "skipped" };
  assert.equal(approvalOutcome(permission, Date.now()), "Skipped");
  const parts = components(approvalOperations(permission, Date.now()));
  assert.equal(parts.find((c) => c.id === "status").text, "Skipped");
  assert.equal(parts.some((c) => c.component === "Button"), false);
  const choice = { ...permission, questions: [{ question: "Which?", header: "", multiSelect: false, options: [{ label: "A" }] }] };
  assert.equal(components(approvalOperations(choice, Date.now())).find((c) => c.id === "status").text, "Skipped");
});

test("a skipped question surface shows Skipped instead of an answer field", () => {
  const { operations } = surfaceOf({ kind: "Question", question: ID, body: "Ship it?", skipped: true });
  const parts = components(operations);
  assert.equal(parts.find((c) => c.id === "status").text, "Skipped");
  assert.equal(parts.some((c) => c.component === "TextField" || c.component === "Button"), false);
});

const require = createRequire(import.meta.url);
const dependencies = {
  "@/components/ui/button": { Button: "button" },
  "@/lib/task-board": { ageOf: () => "just now" },
  "@/lib/task-tags": {},
  "@/lib/selection": {},
  "./cards": { LegacyQuestionCard: ({ body }) => body, LegacyApprovalCard: ({ approval }) => approval.summary, SuspensionCard: () => "suspended" },
};
await swc.loadBindings();
const { code } = await swc.transform(readFileSync(new URL("../web/app/decisions.jsx", import.meta.url), "utf8"), {
  jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
  module: { type: "commonjs" },
});
const exports = {};
new Function("require", "exports", code)((id) => dependencies[id] ?? require(id), exports);
const { DecisionQueue } = exports;

test("the decision queue offers Skip on approvals and questions, not on a suspended run", () => {
  const base = { project: "demo", from: "agent", time: 1 };
  const decisions = [
    { ...base, key: ID, kind: "Approval", approval: { id: ID, summary: "make", state: "pending" } },
    { ...base, key: "123456789abc", kind: "Question", question: "123456789abc", body: "Ship it?" },
    { ...base, key: "s1", kind: "Suspension", suspension: { id: "s1" } },
  ];
  const html = renderToStaticMarkup(createElement(DecisionQueue, { decisions, now: 2000, seen: new Set() }));
  assert.equal([...html.matchAll(/>Skip<\/button>/g)].length, 2);
  assert.match(html, /suspended/);
});
