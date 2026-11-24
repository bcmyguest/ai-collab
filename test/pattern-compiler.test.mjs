import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { compileTrace } from "../lib/pattern-compiler.mjs";
import { BUILT_IN_PATTERNS } from "../lib/patterns.mjs";

const dot = readFileSync(new URL("../lib/team-templates/product/team.dot", import.meta.url), "utf8");
const product = BUILT_IN_PATTERNS.product;
for (const handoff of product.handoffs) assert.ok(dot.includes(`on="${handoff.on}"`), handoff.on);

// The snapshot shape a run stores and decide reads.
const definition = {
  name: product.name,
  roles: product.roles.map((role) => ({ ...role })),
  handoffs: product.handoffs.map((handoff) => ({ ...handoff })),
  ...(product.maxVisits ? { maxVisits: product.maxVisits } : {}),
};

// The opening enter is pm, the role the product team starts in. Later enters are the handoffs.
const visited = (log) => log.steps.flatMap((step) => {
  if (step.step === "done") return ["done"];
  if (step.step === "enter") return [step.role];
  return [];
});

test("product trace in vision, built, reported, task closed ends at done and enters engineer, review, pm, then done", () => {
  const log = compileTrace(definition, ["in vision", "built", "reported", "task closed"]);
  assert.equal(log.status, "done");
  assert.deepEqual(visited(log), ["pm", "engineer", "review", "pm", "done"]);
  assert.deepEqual(visited(log).slice(1), ["engineer", "review", "pm", "done"]);
});

test("an opening task closed is refused because in vision, built, and reported have not fired", () => {
  const log = compileTrace(definition, ["task closed"]);
  assert.equal(log.status, "refused");
  assert.match(log.reason, /in vision/);
  assert.match(log.reason, /built/);
  assert.match(log.reason, /reported/);
  assert.equal(log.active, "pm");
  assert.equal(log.steps.some((step) => step.step === "done"), false);
  assert.equal(log.steps.at(-1).refused, log.reason);
});

test("a fourth changes from the same review instance is refused", () => {
  const outcomes = ["in vision", "built"];
  for (let round = 0; round < 3; round += 1) outcomes.push("changes", "built");
  outcomes.push("changes");
  const log = compileTrace(definition, outcomes);
  assert.equal(log.status, "refused");
  assert.match(log.reason, /cap of 3/);
  assert.equal(log.active, "review");
  assert.equal(log.steps.at(-1).event, "changes");
  assert.equal(log.steps.filter((step) => step.step === "enter" && step.role === "engineer").length, 4);
});
