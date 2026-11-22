import assert from "node:assert/strict";
import { test } from "node:test";
import { everyLabel, jobDetail } from "../web/lib/scheduled.js";

const full = {
  name: "pm", everyMs: 1_800_000, nextRun: "2030-01-01T00:30:00.000Z",
  command: ["node", "pm.mjs", "--once"], cwd: "/srv/pm", last: { id: "1", status: "SUCCESS", scheduledTime: "2030-01-01T00:00:00.000Z", output: "ok", error: null },
};

test("the detail lists each reported field in order", () => {
  assert.deepEqual(jobDetail(full), [
    ["Schedule", "every 30 min"],
    ["Next run", "2030-01-01T00:30:00.000Z"],
    ["Command", "node pm.mjs --once"],
    ["Folder", "/srv/pm"],
    ["Last run", "SUCCESS"],
  ]);
});

test("a field the runner did not send gets no row", () => {
  const rows = jobDetail({ name: "bare", everyMs: 60_000, nextRun: "2030-01-01T00:01:00.000Z", last: null });
  assert.deepEqual(rows.map(([label]) => label), ["Schedule", "Next run"]);
  assert.equal(everyLabel(60_000), "every 1 min");
});

test("the detail names no field the runner does not report", () => {
  const labels = jobDetail(full).map(([label]) => label);
  for (const absent of ["Enabled", "Harness", "Model", "Project", "Duration", "Prompt"]) assert.equal(labels.includes(absent), false);
});
