// The Land panel lists open PRs; Merge is enabled only when every check is green.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import swc from "next/dist/build/swc/index.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const dependencies = {
  "@/components/ui/button": { Button: "button" },
  "./chat-api": { api: async () => ({}) },
};
await swc.loadBindings();
const { code } = await swc.transform(readFileSync(new URL("../web/app/land-panel.jsx", import.meta.url), "utf8"), {
  jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
  module: { type: "commonjs" },
});
const exports = {};
new Function("require", "exports", code)((id) => dependencies[id] ?? require(id), exports);
const { LandPanel } = exports;

const SHA = "d".repeat(40);
const pr = (checks, extra = {}) => ({
  number: 12, title: "Add the land panel", url: "https://github.com/o/r/pull/12", branch: "feat/land-panel",
  headSha: SHA, additions: 120, deletions: 8, checks, ...extra,
});
const render = (props) => renderToStaticMarkup(createElement(LandPanel, { busy: false, result: "", onMerge() {}, ...props }));
const mergeButton = (html) => html.match(/<button[^>]*>Merge<\/button>/)?.[0] ?? "";

test("the panel shows a loading line before the PR list arrives", () => {
  const html = render({ state: null });
  assert.match(html, /Loading open PRs/);
  assert.doesNotMatch(html, /<button/);
});

test("the panel shows the gh error when listing fails", () => {
  const html = render({ state: { error: "gh: not logged in" } });
  assert.match(html, /gh: not logged in/);
});

test("the panel says so when no PR is open", () => {
  assert.match(render({ state: { prs: [] } }), /No open PRs into main/);
});

test("a PR row shows title, branch, line counts, check state and a link to its diff", () => {
  const html = render({ state: { prs: [pr("success")] } });
  assert.match(html, /Add the land panel/);
  assert.match(html, /feat\/land-panel/);
  assert.match(html, /\+120/);
  assert.match(html, /-8/);
  assert.match(html, /Checks green/);
  assert.match(html, /href="https:\/\/github\.com\/o\/r\/pull\/12\/files"/);
});

test("Merge is enabled only when every check is green", () => {
  assert.doesNotMatch(mergeButton(render({ state: { prs: [pr("success")] } })), /disabled/);
  for (const checks of ["failure", "pending", "none"]) {
    assert.match(mergeButton(render({ state: { prs: [pr(checks)] } })), /disabled/, checks);
  }
});

test("Merge is disabled while a merge is running", () => {
  assert.match(mergeButton(render({ state: { prs: [pr("success")] }, busy: true })), /disabled/);
});

test("the panel shows the merge result and the last deploy line", () => {
  const html = render({
    state: { prs: [], deploy: { line: "deployed 111111111111..222222222222", at: "2026-11-26T10:00:00.000Z" } },
    result: "Merged: #12 merged · deploy started",
  });
  assert.match(html, /Merged: #12 merged · deploy started/);
  assert.match(html, /deployed 111111111111\.\.222222222222/);
});
