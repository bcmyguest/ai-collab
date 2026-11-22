import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import swc from "next/dist/build/swc/index.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Render the real queue with its unrelated leaf components replaced.
const require = createRequire(import.meta.url);
const dependencies = {
  "@/components/ui/button": { Button: "button" },
  "@/lib/task-board": { ageOf: () => "just now" },
  "@/lib/task-tags": {},
  "@/lib/selection": {},
  "./cards": { LegacyQuestionCard: ({ body }) => body },
};
await swc.loadBindings();
const { code } = await swc.transform(readFileSync(new URL("../web/app/decisions.jsx", import.meta.url), "utf8"), {
  jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
  module: { type: "commonjs" },
});
const exports = {};
new Function("require", "exports", code)(id => dependencies[id] ?? require(id), exports);
const { DecisionQueue } = exports;

test("new unanswered decisions have an orange badge that clears after an answer", () => {
  const previous = { project: "demo", key: "previous", kind: "Question", from: "agent", body: "Previous decision", time: 1 };
  const fresh = { ...previous, key: "fresh", body: "Fresh decision", time: 2 };
  const seen = new Set([JSON.stringify([previous.project, previous.key])]);
  const render = (decisions, inbox) => renderToStaticMarkup(createElement(DecisionQueue, { decisions, inbox, now: 2000, seen }));
  const badge = /aria-label="Mark new decision as seen"[^>]*bg-orange-500[^>]*>New<\/button>/g;
  for (const inbox of [false, true]) {
    assert.equal([...render([previous], inbox).matchAll(badge)].length, 0);
    const arrived = render([previous, fresh], inbox);
    assert.equal([...arrived.matchAll(badge)].length, 1);
    assert.match(arrived, /Fresh decision/);
    const answered = render([previous], inbox);
    assert.equal([...answered.matchAll(badge)].length, 0);
    assert.match(answered, /Previous decision/);
    assert.doesNotMatch(answered, /Fresh decision/);
  }
});
