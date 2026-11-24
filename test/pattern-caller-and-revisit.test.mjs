import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compileTrace } from "../lib/pattern-compiler.mjs";
import { activatePatternTargets, applyPatternAdvance, cutPatternEnter, launchPatternRun, runStatus } from "../lib/pattern-runs.mjs";
import { seedPatternRun } from "../lib/pattern-workflow.mjs";

const parallel = {
  name: "parallel",
  roles: [{ id: "worker", count: 2 }, { id: "reviewer", count: 2 }],
  handoffs: [
    { from: "worker", to: "reviewer", on: "built", kind: "pair" },
    { from: "reviewer", to: "done", on: "approved", kind: "pair" },
  ],
};

const cycle = {
  name: "cycle",
  roles: [
    { id: "worker", harness: "claude", responsibility: "Build." },
    { id: "reviewer", harness: "claude", responsibility: "Review." },
  ],
  handoffs: [
    { from: "worker", to: "reviewer", on: "built" },
    { from: "reviewer", to: "worker", on: "changes" },
    { from: "reviewer", to: "done", on: "approved" },
  ],
};

test("trace replays explicit callers in the order that parallel roles actually finished", () => {
  const outcomes = [
    { event: "built", role: "worker", index: 1 },
    { event: "approved", role: "reviewer", index: 1 },
    { event: "built", role: "worker", index: 0 },
    { event: "approved", role: "reviewer", index: 0 },
  ];
  const trace = compileTrace(parallel, outcomes);
  assert.equal(trace.status, "done", trace.reason);
  assert.deepEqual(
    trace.steps.filter(({ step }) => step === "event").map(({ event, role, index }) => ({ event, role, index })),
    outcomes,
  );
  assert.deepEqual(
    trace.steps.filter(({ step, role }) => step === "enter" && role === "reviewer").map(({ index }) => index),
    [1, 0],
  );
});

test("an outcome addressed to an inactive lane cannot advance another lane", () => {
  const event = { event: "approved", role: "reviewer", index: 0 };
  const trace = compileTrace(parallel, [{ event: "built", role: "worker", index: 1 }, event]);
  assert.equal(trace.status, "refused");
  assert.match(trace.reason, /only the active role/);
  assert.deepEqual(trace.steps.at(-2), { step: "event", ...event });
});

test("a trace refuses additional events after the run finishes", () => {
  const trace = compileTrace(parallel, ["built", "built", "approved", "approved", "built"]);
  assert.equal(trace.status, "refused");
  assert.match(trace.reason, /no live role/);
  assert.deepEqual(trace.steps.at(-2), { step: "done" });
  assert.deepEqual(trace.steps.at(-1), { step: "leave", refused: trace.reason });
});

test("recovery refuses to assume a reused session received a revisited role brief", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "aic-dot-revisit-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const cfg = { project: "demo", stateDir };
  const id = "trace42";
  let starts = 0;
  const start = async () => ({ status: "started", session: `claude#${String(++starts).padStart(16, "0")}` });
  const options = { start, override: true, launchNext: false };
  await launchPatternRun(cfg, seedPatternRun({ name: cycle.name, task: "Build", definition: cycle }, id), {}, start);
  const left = await applyPatternAdvance(cfg, id, "built", options);
  await activatePatternTargets(cfg, id, left.targets, left.arrival, { start });
  const revisit = await applyPatternAdvance(cfg, id, "changes", options);
  assert.equal(runStatus(cfg, id).instances.worker[0], "claude#0000000000000001");
  const cut = cutPatternEnter(cfg, id, revisit.targets);
  assert.equal(cut.reply.status, "failed");
  assert.equal(runStatus(cfg, id).status, "failed");
  assert.equal(starts, 2);
});
