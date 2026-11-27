import assert from "node:assert/strict";
import { test, after } from "node:test";
import path from "node:path";
import { openDurable } from "../lib/durable.ts";
import { createRunner } from "../runner/runner.ts";
import { sessionLabel } from "../lib/config.ts";
import { parseSelection } from "../web/lib/selection.js";
import { runLink } from "../web/lib/scheduled.js";
import { tempDir } from "./helpers/tmp.mjs";

const tmp = () => tempDir({ after }, "ai-collab-run-detail-");
const CONVERSATION = "36329f36-ceda-4ac6-ae5f-4b36e16c8e95";

// A runner over a durable log with one schedule entry; the default command prints a line, so the run finishes at once.
async function runnerWith(entries) {
  const durable = openDurable(path.join(tmp(), "runner.db"));
  const withEntry = entries.map((entry) => ({ cwd: tmp(), command: [process.execPath, "-e", "console.log('tick')"], timeoutMs: 10_000, ...entry }));
  durable.scheduled("pm", { everyMs: 60_000, firstStep: "command" }, async () => "ok");
  const runner = createRunner({ projects: [], adapters: new Map(), durable, env: {}, watch: false, scheduleEntries: withEntry });
  return { durable, runner };
}

test("each run reports its start and end, and the session its command resumes", async () => {
  const { durable, runner } = await runnerWith([{ name: "pm", everyMs: 60_000, command: ["cursor-agent", "-p", "--resume", CONVERSATION, "tick"] }]);
  try {
    const started = await runner.runSchedule("pm");
    await durable.result(started.id);
    const [run] = await runner.scheduleRuns("pm");
    assert.equal(run.status, "SUCCESS");
    assert.ok(Number.isSafeInteger(run.startedAt));
    assert.ok(Number.isSafeInteger(run.finishedAt));
    assert.ok(run.finishedAt >= run.startedAt);
    assert.deepEqual(run.session, { harness: "cursor", session: sessionLabel(CONVERSATION) });
  } finally {
    await durable.close();
  }
});

test("a run's link opens the project's timeline for exactly that run", async () => {
  const { durable, runner } = await runnerWith([{ name: "pm", everyMs: 60_000, command: ["cursor-agent", "-p", "--resume", CONVERSATION, "tick"] }]);
  try {
    const started = await runner.runSchedule("pm");
    await durable.result(started.id);
    const [run] = await runner.scheduleRuns("pm");
    const selected = parseSelection(runLink({ ...run, project: "demo" }, "demo").slice(1));
    assert.equal(selected.project, "demo");
    assert.equal(selected.session, "cursor#" + sessionLabel(CONVERSATION));
    assert.equal(selected.tab, "activity");
    assert.ok(selected.window.from < run.startedAt && selected.window.to > run.startedAt);
  } finally {
    await durable.close();
  }
});

test("a schedule whose command resumes no session lists its runs without a link", async () => {
  const { durable, runner } = await runnerWith([{ name: "pm", everyMs: 60_000, command: ["node", "pm.mjs", "--once"] }]);
  try {
    const started = await runner.runSchedule("pm");
    await durable.result(started.id);
    const [run] = await runner.scheduleRuns("pm");
    assert.equal(run.session, undefined);
    assert.ok(Number.isSafeInteger(run.startedAt));
    assert.equal(runLink({ ...run, project: "demo" }, "demo"), "");
  } finally {
    await durable.close();
  }
});
