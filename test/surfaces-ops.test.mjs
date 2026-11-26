import assert from "node:assert/strict";
import { test } from "node:test";
import { CODE_TOOLS, READ_TOOLS } from "../lib/code-run.mjs";
import { OPS } from "../lib/surfaces/ops.ts";

const tagged = (surface) => OPS.filter((op) => op.surfaces.includes(surface)).map((op) => op.name);

test("operation names are unique", () => {
  assert.equal(new Set(OPS.map((op) => op.name)).size, OPS.length);
});

test("run_code's ai client exposes exactly the code-tagged operations", () => {
  assert.deepEqual(tagged("code").sort(), [...CODE_TOOLS].sort());
  assert.deepEqual(OPS.filter((op) => READ_TOOLS.includes(op.name)).map((op) => op.name).sort(), [...READ_TOOLS].sort());
});

test("every operation is rendered to the MCP surface", () => {
  assert.ok(OPS.every((op) => op.surfaces.includes("mcp")));
});
