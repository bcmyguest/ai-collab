import assert from "node:assert/strict";
import path from "node:path";
import { test, after } from "node:test";
import { activatePatternTargets, applyPatternAdvance, cutPatternEnter, cutPatternEntry, cutPatternLeave, launchPatternRun, runStatus } from "../lib/pattern-runs.ts";
import { patternWorkflowId, runPatternWorkflow, seedPatternRun } from "../lib/pattern-workflow.ts";
import { openDurable } from "../runner/durable.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const definition = {
  name: "handoff",
  roles: [
    { id: "engineer", responsibility: "Build the change.", harness: "claude" },
    { id: "review", responsibility: "Review the change.", harness: "claude" },
  ],
  handoffs: [
    { from: "engineer", to: "review", on: "built", required: true },
    { from: "review", to: "done", on: "reported", required: false },
  ],
};

function fixture() {
  const home = tempDir({ after }, "ai-collab-pattern-workflow-");
  const cfg = { project: "demo", peer: "operator", session: "", stateDir: path.join(home, "state"), peers: [] };
  const launches = [];
  const start = async (_cfg, options) => {
    const role = options.prompt.match(/role "([^"]+)"/)[1];
    launches.push(role);
    return { status: "started", session: `${role}#0000000000000001`, detail: "ok" };
  };
  return { home, cfg, env: {}, launches, start, db: path.join(home, "runner.db"), runId: "trace01" };
}

function workflowDeps(ctx, extra = {}) {
  const { cfg, env, start } = ctx;
  return {
    enterEntry: (input, runId) => launchPatternRun(cfg, seedPatternRun(input, runId, () => 1_000_000), env, start),
    leave: async (runId, message) => {
      const advanced = await applyPatternAdvance(cfg, runId, message.event, {
        ...message.options, env, start, now: () => 2_000_000, launchNext: false,
      });
      const targets = advanced.targets ?? [];
      const reply = { ...advanced };
      delete reply.targets;
      delete reply.arrival;
      return { reply, launch: advanced.status === "running" && targets.length > 0, targets, arrival: advanced.arrival };
    },
    enterNext: async (runId, left) => {
      const activated = await activatePatternTargets(cfg, runId, left.targets, left.arrival, { env, start });
      return { reply: { ...left.reply, ...activated, handoff: left.reply?.handoff } };
    },
    cutEntry: (_input, runId) => cutPatternEntry(cfg, runId),
    cutLeave: (runId) => cutPatternLeave(cfg, runId),
    cutEnter: (runId, left) => cutPatternEnter(cfg, runId, left.targets),
    ...extra,
  };
}

const input = { name: definition.name, task: "Ship the change", definition, project: "demo" };

async function until(fn, label) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > 5000) throw new Error(label);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function waitForAbort(wf) {
  return new Promise((_, reject) => {
    if (wf.signal.aborted) reject(new Error("closed"));
    wf.signal.addEventListener("abort", () => reject(new Error("closed")), { once: true });
  });
}

test("recovery starts review once after leave recorded built and does not apply built again", async () => {
  const ctx = fixture();
  const workflowId = patternWorkflowId(ctx.runId);
  let release = () => {};
  const sawBuilt = new Promise((resolve) => { release = resolve; });
  const first = openDurable(ctx.db);
  first.register("pattern", (wf, recorded) => runPatternWorkflow(wf, recorded, workflowDeps(ctx, {
    between: async (wf, left) => {
      if (left.reply?.handoff?.on !== "built") return;
      release();
      await waitForAbort(wf);
    },
  })));
  const running = first.startWorkflow("pattern", workflowId, input);
  running.catch(() => {});
  first.send(workflowId, "advance", { event: "built", options: { override: true, by: "test" } });
  await sawBuilt;

  const steps = first.steps(workflowId);
  assert.deepEqual(steps.map((step) => step.name), ["enter", "event", "leave"]);
  assert.ok(steps.every((step) => step.status === "done"));
  assert.equal(JSON.parse(steps.at(-1).output).reply.handoff.on, "built");
  assert.deepEqual(ctx.launches, ["engineer"]);
  assert.equal(runStatus(ctx.cfg, ctx.runId).handoffs.filter((handoff) => handoff.on === "built").length, 1);
  assert.equal(first.status(workflowId).name, "pattern");
  await first.close();

  const second = openDurable(ctx.db);
  second.register("pattern", (wf, recorded) => runPatternWorkflow(wf, recorded, workflowDeps(ctx)));
  assert.deepEqual(second.recover(), [workflowId]);
  await until(() => second.steps(workflowId).filter((step) => step.name === "enter" && step.status === "done").length === 2, "review enter");
  assert.deepEqual(ctx.launches, ["engineer", "review"]);
  assert.equal(runStatus(ctx.cfg, ctx.runId).handoffs.filter((handoff) => handoff.on === "built").length, 1);
  const recorded = second.listNamed("pattern", 1)[0];
  assert.equal(recorded.input.name, "handoff");
  assert.equal(recorded.input.task, "Ship the change");
  assert.equal(recorded.input.definition.roles[1].id, "review");
  await second.close();
});

test("a step left started does not launch a second session", async () => {
  const ctx = fixture();
  const workflowId = patternWorkflowId(ctx.runId);
  let release = () => {};
  const sawReview = new Promise((resolve) => { release = resolve; });
  const first = openDurable(ctx.db);
  first.register("pattern", (wf, recorded) => runPatternWorkflow(wf, recorded, workflowDeps(ctx, {
    afterEnter: async (wf) => {
      release();
      await waitForAbort(wf);
    },
  })));
  const running = first.startWorkflow("pattern", workflowId, input);
  running.catch(() => {});
  first.send(workflowId, "advance", { event: "built", options: { override: true, by: "test" } });
  await sawReview;
  assert.deepEqual(ctx.launches, ["engineer", "review"]);
  const cut = first.steps(workflowId).find((step) => step.name === "enter" && step.status === "started");
  assert.ok(cut, "review enter is still started");
  await first.close();

  const second = openDurable(ctx.db);
  second.register("pattern", (wf, recorded) => runPatternWorkflow(wf, recorded, workflowDeps(ctx)));
  assert.deepEqual(second.recover(), [workflowId]);
  await until(() => second.steps(workflowId).find((step) => step.seq === cut.seq)?.status === "done", "cut enter resumed");
  assert.deepEqual(ctx.launches, ["engineer", "review"]);
  assert.equal(JSON.parse(second.steps(workflowId).find((step) => step.seq === cut.seq).output).reply.detail, "resumed");
  await second.close();
});
