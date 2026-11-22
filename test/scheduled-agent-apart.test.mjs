import assert from "node:assert/strict";
import { test } from "node:test";
import { jobAgent, jobDetail } from "../web/lib/scheduled.js";

const pm = {
  name: "pm", everyMs: 1_800_000, nextRun: "2030-01-01T00:30:00.000Z",
  command: ["/home/me/.local/bin/cursor-agent", "-p", "--resume", "36329f36-ceda-4ac6-ae5f-4b36e16c8e95", "PM tick"],
  cwd: "/srv/pm", last: { id: "1", status: "SUCCESS", scheduledTime: "2030-01-01T00:00:00.000Z" },
  session: { harness: "cursor", session: "36329f36ceda4ac6" },
};

test("a job that resumes an agent names it on its own row, apart from the job's command", () => {
  assert.equal(jobAgent(pm), "cursor#36329f36ceda4ac6");
  assert.deepEqual(jobDetail(pm).at(-1), ["Resumes", "cursor#36329f36ceda4ac6"]);
  assert.equal(jobDetail(pm).some(([label, value]) => label === "Agent" || value === "pm"), false, "the job is not the agent");
});

test("a job that resumes no session gets no Resumes row", () => {
  assert.equal(jobAgent({ name: "cleanup", everyMs: 60_000 }), "");
  assert.equal(jobAgent({ name: "x", everyMs: 60_000, session: { harness: "cursor" } }), "");
  assert.equal(jobDetail({ name: "cleanup", everyMs: 60_000 }).some(([label]) => label === "Resumes"), false);
});
