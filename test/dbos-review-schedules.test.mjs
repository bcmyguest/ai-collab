// Reviewer finding 6: the DBOS engine must skip a tick whose previous run is still going,
// show skipped ticks as SKIPPED in the run list, and let intervalReason see past manual runs.
import assert from "node:assert/strict";
import test from "node:test";
import { openWorkflows } from "../lib/workflows.ts";
import { pgUrl } from "../lib/postgres.ts";
import { dbosTestDb } from "./helpers/dbos-env.mjs";

const pgUp = await dbosTestDb();
const iso = (ms) => new Date(ms).toISOString();

test("dbos schedules: overlap skip, SKIPPED visibility, and a manual run that does not hide the interval", { skip: pgUp ? false : "no Postgres on 127.0.0.1:5432", timeout: 120_000 }, async () => {
  // Tick ids are deterministic from the clock, and DBOS dedupes workflow ids globally: start from
  // a per-run base so a failed run's rows can never collide with the next run's tick ids.
  const base = Date.now();
  let clock = base;
  const wf = await openWorkflows({ engine: "dbos", pgUrl: pgUrl(), now: () => clock, applicationVersion: `aic-sched-${Date.now()}` });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  wf.scheduled("pm", { everyMs: 60_000 }, async () => { await gate; return "done"; });
  wf.scheduled("beat", { everyMs: 90_000 }, async () => "ran");
  try {
    // Grace-tick ids are deterministic grid points a later run can reuse: clear old runs' rows first,
    // or the skip insert (ON CONFLICT DO NOTHING on the shared id) would silently drop this run's.
    await wf.prune(["scheduled:pm", "scheduled:beat"], Date.now() + 60_000);
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
    const prev = `beat@${iso(base)}`;
    assert.equal(await wf.startWorkflowOnce("scheduled:beat", prev, { scheduledTime: base, actualTime: base }), true);
    await wf.result(prev);
    await wf.runScheduled("beat"); // the newest row is now a manual run: it must not hide the interval
    // The grace-fire only fires when the clock sits on the schedule grid, and its tick id is that
    // grid point: step to the next beat grid point, under everyMs past the last tick.
    clock = Math.ceil(base / 90_000) * 90_000;
    await wf.startSchedules(); // grace-fires beat: under the 90 s interval since the last tick, so it is skipped
    const beatRuns = await wf.scheduleRuns("beat");
    assert.equal(beatRuns[0].status, "SKIPPED", "the too-early tick is recorded SKIPPED");
    assert.match(beatRuns[0].output.skipped, /interval changed/);
    assert.equal((await wf.schedules()).find((s) => s.name === "beat").last.status, "SUCCESS");
  } finally {
    release();
    await wf.close();
  }
});
