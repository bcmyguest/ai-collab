import test, { after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openDurable } from "../runner/durable.mjs";
import { listenControl, route } from "../runner/control.ts";
import { readScheduleRuns, readSchedules } from "../web/server/schedules.ts";
import { tempDir } from "./helpers/tmp.mjs";

const tmp = () => tempDir({ after }, "ai-collab-runs-");

test("the durable store lists a schedule's ticks and refuses an unknown schedule with 404", async () => {
  const durable = openDurable(path.join(tmp(), "runner.db"), { now: () => 600_000 });
  try {
    durable.scheduled("beat", { everyMs: 60_000 }, async () => "ok");
    const started = await durable.runScheduled("beat");
    await durable.result(started.id);
    const runs = durable.scheduleRuns("beat");
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "SUCCESS");
    assert.throws(() => durable.scheduleRuns("nope"), { status: 404 });
  } finally {
    await durable.close();
  }
});

test("the control socket answers a schedule's runs to GET and refuses other methods", async () => {
  const runner = { scheduleRuns: (name) => [{ id: "x", status: "SUCCESS", name }] };
  const [status, body] = await route(runner, "GET", new URL("http://runner.invalid/v1/schedules/beat/runs"), {});
  assert.equal(status, 200);
  assert.equal(body[0].name, "beat");
  await assert.rejects(route(runner, "POST", new URL("http://runner.invalid/v1/schedules/beat/runs"), {}), { status: 405 });
});

test("the UI reads schedules over the socket and reports offline when no runner listens", async () => {
  const socket = path.join(tmp(), "runner.sock");
  assert.deepEqual(await readSchedules({ socket }), { status: "offline" });
  const runner = {
    schedules: () => ({
      schedules: [{ name: "pm", everyMs: 1_800_000, nextRun: "2030-01-01T00:00:00.000Z", last: null, command: ["node", "pm.mjs"], cwd: "/tmp" }],
      configError: [],
    }),
    scheduleRuns: () => [],
  };
  const control = await listenControl(runner, socket);
  try {
    const up = await readSchedules({ socket });
    assert.equal(up.status, "up");
    assert.equal(up.schedules[0].name, "pm");
    assert.deepEqual(await readScheduleRuns("pm", { socket }), []);
  } finally {
    await control.close();
  }
  await assert.rejects(readScheduleRuns("pm", { socket }), { status: 503 });
});
