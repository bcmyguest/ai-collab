// Reviewer finding N1 (MEDIUM, sqlite default path): the wake loop renamed its recorded `wake.more`
// step to a `recv:wake` recv at the same sequence position. A wake in flight on its second+ batch at
// upgrade replays that row, hits NonDeterminismError, ends ERROR without onCut and never releases its
// reservations. The recorded sequence must stay: ... wake.wait, wake.more (step), recv:wake (recv).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openDurable } from "../lib/durable.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The wake loop's recorded sequence as the pre-upgrade runner wrote it: wake.more step, then a blocking recv-all.
function oldWake(durable) {
  durable.register("wake", async (wf) => {
    await wf.step("wake.reserve", () => ({ owned: ["m1"], busy: false }));
    await wf.step("wake.send", () => ({ runId: "r1" }));
    await wf.step("wake.wait", () => "waited");
    const more = await wf.step("wake.more", () => true);
    if (!more) return "no-more";
    return await wf.recv("wake", { all: true }); // blocking: no message arrives, so closing the log cuts the run here
  });
}

// The wake loop's sequence after the non-blocking recv-all change. withWakeMore=false is the regression:
// the recv lands on the row the old runner recorded as wake.more.
function newWake(durable, { withWakeMore }) {
  durable.register("wake", async (wf) => {
    await wf.step("wake.reserve", () => ({ owned: ["m1"], busy: false }));
    await wf.step("wake.send", () => ({ runId: "r1" }));
    await wf.step("wake.wait", () => "waited");
    if (withWakeMore) {
      const more = await wf.step("wake.more", async () => (await wf.pending("wake")) > 0);
      if (!more) return "no-more";
    }
    const batch = await wf.recv("wake", { all: true, timeoutSeconds: 0 });
    return { batch };
  });
}

// Runs the old body until wake.more is recorded, then closes the log mid-recv: the run stays PENDING.
async function recordOldFormatWake(file, id) {
  const first = openDurable(file);
  oldWake(first);
  first.startWorkflow("wake", id, {}).catch(() => {});
  for (let i = 0; i < 400; i++) {
    if (first.steps(id).some((s) => s.seq === 3 && s.status === "done")) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  await first.close();
}

test("a wake log recorded in the old format resumes with the wake.more step kept", async () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "aic-wakelog-")), "durable.db");
  await recordOldFormatWake(file, "wake:demo#claude#s1:m1");

  const second = openDurable(file);
  newWake(second, { withWakeMore: true });
  const ids = await second.recover();
  assert.ok(ids.includes("wake:demo#claude#s1:m1"), "the cut wake is pending for recovery");
  const out = await second.result("wake:demo#claude#s1:m1");
  assert.deepEqual(out, { batch: [] }, "the wake resumes past the recorded wake.more and polls the empty backlog");
  await second.close();
});

test("dropping the wake.more step breaks the recorded log (the regression this guards)", async () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "aic-wakelog-")), "durable.db");
  await recordOldFormatWake(file, "wake:drop#s1:m1");

  const second = openDurable(file);
  newWake(second, { withWakeMore: false });
  await second.recover();
  for (let i = 0; i < 400 && second.status("wake:drop#s1:m1").status === "PENDING"; i++) await new Promise((r) => setTimeout(r, 10));
  const st = second.status("wake:drop#s1:m1");
  assert.equal(st.status, "ERROR", "recv at the wake.more position must throw NonDeterminismError");
  assert.match(st.error, /NonDeterminismError|was wake\.more/);
  await second.close();
});

test("the runner wake loop keeps the recorded wake.more step before its recv", () => {
  const src = readFileSync(path.join(HERE, "..", "runner", "runner.mjs"), "utf8");
  const more = src.indexOf('wf.step("wake.more"');
  const recv = src.indexOf("wf.recv(WAKE_TOPIC");
  assert.ok(more !== -1, 'the wake loop must keep the recorded step("wake.more") for pre-upgrade logs');
  assert.ok(recv !== -1 && more < recv, "wake.more must be recorded before the wake recv");
});
