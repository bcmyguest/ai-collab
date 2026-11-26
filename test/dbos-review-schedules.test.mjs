// Reviewer finding 6: the DBOS engine must skip a tick whose previous run is still going,
// show skipped ticks as SKIPPED in the run list, and let intervalReason see past manual runs.
import assert from "node:assert/strict";
import test from "node:test";
import { openWorkflows } from "../lib/workflows.ts";
import { pgReachable, pgUrl } from "../lib/postgres.mjs";

const pgUp = await pgReachable();
const iso = (ms) => new Date(ms).toISOString();

test("dbos schedules: overlap skip, SKIPPED visibility, and a manual run that does not hide the interval", { skip: pgUp ? false : "no Postgres on 127.0.0.1:5432", timeout: 120_000 }, async () => {
  let clock = 1_200_000;
  const wf = await openWorkflows({ engine: "dbos", pgUrl: pgUrl(), now: () => clock });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  wf.scheduled("pm", { everyMs: 60_000 }, async () => { await gate; return "done"; });
  wf.scheduled("beat", { everyMs: 90_000 }, async () => "ran");
  try {
    // a second tick while the first still runs is skipped, recorded SKIPPED, and does not take the last-run slot
    const first = await wf.runScheduled("pm");
    assert.equal(first.status, "started");
    assert.equal((await wf.runScheduled("pm")).status, "skipped", "an overlapping tick is skipped, not started");
    const pmRuns = await wf.scheduleRuns("pm");
    assert.equal(pmRuns[0].status, "SKIPPED");
    assert.match(pmRuns[0].output.skipped, /previous run still going/);
    assert.notEqual((await wf.schedules()).find((s) => s.name === "pm").last.status, "SKIPPED");
    release();
    assert.equal(await wf.result(first.id), "done");

    // an interval tick under the edited interval after the last real run is skipped even when a manual run is newer
    const prev = `beat@${iso(1_200_000)}`;
    assert.equal(await wf.startWorkflowOnce("scheduled:beat", prev, { scheduledTime: 1_200_000, actualTime: 1_200_000 }), true);
    await wf.result(prev);
    await wf.runScheduled("beat"); // the newest row is now a manual run: it must not hide the interval
    clock = 1_260_000;
    await wf.startSchedules(); // grace-fires beat at 1_260_000: 60 s after the last tick, under the 90 s interval
    const beatRuns = await wf.scheduleRuns("beat");
    assert.equal(beatRuns[0].status, "SKIPPED", "the too-early tick is recorded SKIPPED");
    assert.match(beatRuns[0].output.skipped, /interval changed/);
    assert.equal((await wf.schedules()).find((s) => s.name === "beat").last.status, "SUCCESS");
  } finally {
    release();
    await wf.close();
  }
});
