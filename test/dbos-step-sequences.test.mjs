// DBOS replays a PENDING run against its recorded ops by position, and recovers only runs recorded under
// the current applicationVersion. A change to a workflow's op sequence must therefore bump DBOS_APP_VERSION
// (lib/workflows.ts) and add a golden entry under the new version; an existing version's entry never changes.
// UPDATE_DBOS_STEP_GOLDEN=1 adds the entry for a new version and refuses to rewrite an existing one.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DBOS_APP_VERSION } from "../lib/workflows.ts";

const GOLDEN = fileURLToPath(new URL("./golden/dbos-step-sequences.json", import.meta.url));
const src = (file) => readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");

// Each workflow the runner registers on the engine, and the functions whose bodies issue its recorded ops.
const WORKFLOWS = {
  session: [["runner/runner.mjs", "sessionWorkflow"]],
  wake: [["runner/runner.mjs", "wakeWorkflow"]],
  delivery: [["runner/delivery.mjs", "deliveryWorkflow"]],
  pattern: [["runner/runner.mjs", "patternWorkflow"], ["runner/runner.mjs", "runPattern"], ["lib/pattern-workflow.mjs", "runPatternWorkflow"]],
  "scheduled:*": [["runner/schedules.mjs", "tickFn"]],
};
const OP = /\b(?:wf|ctx)\.(step|recv|sleep)\(/g;

/** Index just past the bracket that closes the one at `open`; skips strings and comments. */
function closeOf(text, open) {
  const pairs = { "(": ")", "{": "}", "[": "]" };
  const stack = [];
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") { i = text.indexOf("\n", i); continue; }
    if (c === "/" && text[i + 1] === "*") { i = text.indexOf("*/", i) + 1; continue; }
    if (c === '"' || c === "'") { for (i += 1; text[i] !== c; i += text[i] === "\\" ? 2 : 1); continue; }
    if (c === "`") {
      for (i += 1; text[i] !== "`"; i += 1) {
        if (text[i] === "\\") i += 1;
        else if (text[i] === "$" && text[i + 1] === "{") i = closeOf(text, i + 1) - 1;
      }
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack.at(-1)) { stack.pop(); if (!stack.length) return i + 1; }
  }
  throw new Error(`unbalanced bracket at ${open}`);
}

/** [start, end) of a named function's body. */
function span(text, name) {
  const m = new RegExp(`function ${name}\\(`).exec(text);
  if (!m) throw new Error(`no function ${name}`);
  const params = closeOf(text, m.index + m[0].length - 1);
  const body = text.indexOf("{", params);
  return [body, closeOf(text, body)];
}

/** Each recorded op call site in [start, end): step by name, recv by its arguments, sleep alone. */
function ops(text, [start, end]) {
  const out = [];
  for (const m of text.slice(start, end).matchAll(OP)) {
    const at = start + m.index + m[0].length - 1;
    const args = text.slice(at + 1, closeOf(text, at) - 1).replace(/\s+/g, " ").trim();
    if (m[1] === "step") out.push(`step:${args.split(",")[0].trim().replace(/^"(.*)"$/, "$1")}`);
    else if (m[1] === "recv") out.push(`recv:${args}`);
    else out.push("sleep");
  }
  return out;
}

function sequences() {
  const result = {};
  const covered = new Map();
  for (const [workflow, fns] of Object.entries(WORKFLOWS)) {
    result[workflow] = [];
    for (const [file, fn] of fns) {
      const text = src(file);
      const range = span(text, fn);
      result[workflow].push(...ops(text, range));
      covered.set(file, [...(covered.get(file) ?? []), range]);
    }
  }
  // Every op call site in these files belongs to a listed workflow: a new helper that records ops must be listed.
  for (const [file, ranges] of covered) {
    const text = src(file);
    for (const m of text.matchAll(OP)) {
      const inside = ranges.some(([a, b]) => m.index >= a && m.index < b);
      assert.ok(inside, `${file}:${text.slice(0, m.index).split("\n").length} issues a recorded op outside every listed workflow function; add it to WORKFLOWS`);
    }
  }
  return result;
}

test("each registered workflow's recorded op sequence matches the golden for DBOS_APP_VERSION", () => {
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
  const current = sequences();
  if (process.env.UPDATE_DBOS_STEP_GOLDEN === "1" && !golden[DBOS_APP_VERSION]) {
    golden[DBOS_APP_VERSION] = current;
    writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 2)}\n`);
  }
  assert.ok(golden[DBOS_APP_VERSION], `no golden entry for ${DBOS_APP_VERSION}; run with UPDATE_DBOS_STEP_GOLDEN=1 to add it`);
  assert.deepEqual(current, golden[DBOS_APP_VERSION],
    `a workflow's recorded op sequence changed under ${DBOS_APP_VERSION}: PENDING DBOS runs would replay against the wrong ops. ` +
    "Bump DBOS_APP_VERSION in lib/workflows.ts, then run with UPDATE_DBOS_STEP_GOLDEN=1 to add the new version's entry.");
});
