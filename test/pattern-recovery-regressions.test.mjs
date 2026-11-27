import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { compileTrace } from "../lib/pattern-compiler.ts";
import { applyPatternAdvance, cutPatternEnter, cutPatternLeave, launchPatternRun, runStatus } from "../lib/pattern-runs.mjs";
import { seedPatternRun } from "../lib/pattern-workflow.mjs";
import { saveTeamText } from "../lib/patterns.mjs";
import { createFakeAdapter } from "../runner/adapters/fake.mjs";
import { openDurable } from "../runner/durable.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { makeRunner, setup, until } from "./helpers/runner-ctx.mjs";

const definition = {
  name: "handoff",
  roles: [
    { id: "engineer", responsibility: "Build the change.", harness: "claude" },
    { id: "reviewer", responsibility: "Review the change.", harness: "claude" },
  ],
  handoffs: [
    { from: "engineer", to: "reviewer", on: "ready" },
    { from: "reviewer", to: "done", on: "approved" },
  ],
};
const input = { name: definition.name, task: "Ship the change", definition, project: "demo" };
const runId = "trace01";
const start = async () => ({ status: "started", session: "claude#0000000000000001" });

async function fixture(t) {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  t.after(async () => {
    await fake.close();
    rmSync(ctx.home, { recursive: true, force: true });
  });
  return ctx;
}

test("each concurrent advance receives its own outcome", { timeout: 5000 }, async (t) => {
  const ctx = await fixture(t);
  const git = (...args) => execFileSync("git", ["-C", ctx.root, ...args], { env: ctx.env, stdio: "ignore" });
  git("init");
  git("-c", "user.name=Tests", "-c", "user.email=tests@example.test", "commit", "--allow-empty", "-m", "initial");
  await saveTeamText(ctx.cfg, "handoff", 'digraph handoff { engineer [agent=claude, prompt="Build"]; engineer -> done [on="ready"]; }', ctx.env, {});
  const adapter = createFakeAdapter({ harness: "claude", capabilities: { places: ["openshell"] } });
  const { runner } = makeRunner(ctx, [adapter]);
  try {
    await runner.boot();
    const started = await runner.startPattern({ project: "demo", name: "handoff", task: "Ship the change" });
    const advance = { project: "demo", id: started.id, override: true };
    const [bad, good] = await Promise.allSettled([
      runner.advancePattern({ ...advance, event: "skip" }),
      runner.advancePattern({ ...advance, event: "ready" }),
    ]);
    assert.equal(bad.status, "rejected");
    assert.match(bad.reason.message, /no handoff "skip"/);
    assert.equal(good.value?.status, "done");
  } finally {
    await runner.stop();
  }
});

test("runner replays a pending pattern from the previous workflow format", { timeout: 5000 }, async (t) => {
  const ctx = await fixture(t);
  const legacyDefinition = {
    ...definition,
    roles: [definition.roles[0]],
    handoffs: [{ from: "engineer", to: "done", on: "ready" }],
  };
  const initial = seedPatternRun({ ...input, definition: legacyDefinition }, runId);
  const id = `pattern:demo:${runId}`;
  const legacy = openDurable(ctx.db);
  legacy.register("pattern", async (wf) => {
    await wf.step("pattern.entry", () => launchPatternRun(ctx.cfg, initial, ctx.env, start));
    await wf.recv("advance");
  });
  legacy.startWorkflow("pattern", id, { project: "demo", initial, request: "legacy-entry" });
  await until(() => legacy.steps(id)[0]?.status === "done", "legacy entry");
  await legacy.close();

  const { runner, durable } = makeRunner(ctx, []);
  try {
    await runner.boot();
    const finished = await runner.advancePattern({ project: "demo", id: runId, event: "ready", override: true });
    assert.equal(finished.status, "done");
    assert.deepEqual(durable.steps(id).map((step) => step.name), ["pattern.entry", "recv:advance", "pattern.advance"]);
  } finally {
    await runner.stop();
  }
});

test("a cut enter with no recorded target session fails the run", async (t) => {
  const ctx = await fixture(t);
  await launchPatternRun(ctx.cfg, seedPatternRun(input, runId), ctx.env, start);
  const left = await applyPatternAdvance(ctx.cfg, runId, "ready", { override: true, launchNext: false });
  const cut = cutPatternEnter(ctx.cfg, runId, left.targets);
  assert.equal(cut.reply.status, "failed");
  assert.equal(runStatus(ctx.cfg, runId).status, "failed");
});

test("a cut leave after recording an edge fails the run without applying it again", async (t) => {
  const ctx = await fixture(t);
  await launchPatternRun(ctx.cfg, seedPatternRun(input, runId), ctx.env, start);
  await applyPatternAdvance(ctx.cfg, runId, "ready", { override: true, launchNext: false });
  const cut = cutPatternLeave(ctx.cfg, runId);
  assert.equal(cut.reply.status, "failed");
  assert.equal(cut.launch, false);
  assert.equal(runStatus(ctx.cfg, runId).handoffs.length, 1);
});

test("fan-in logs the instance whose outcome completes the handoff", () => {
  const fanIn = {
    ...definition,
    roles: [{ ...definition.roles[0], count: 2 }, definition.roles[1]],
    handoffs: [{ ...definition.handoffs[0], kind: "fan-in" }, definition.handoffs[1]],
  };
  const { status, steps } = compileTrace(fanIn, ["ready", "ready", "approved"]);
  assert.equal(status, "done");
  assert.deepEqual(steps.filter((step) => step.role === "engineer" && step.step === "leave").map(({ index, kind }) => [index, kind]), [
    [0, "wait"],
    [1, "move"],
  ]);
});
