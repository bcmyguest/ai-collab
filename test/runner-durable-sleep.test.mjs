import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDurable } from "../runner/durable.mjs";

const dbFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), "ai-collab-sleep-")), "runner.db");

test("a durable sleep keeps its deadline across a restart: the rest of the wait, not a new one", async () => {
  const file = dbFile();
  let after = 0;
  const flow = async (wf) => { await wf.sleep(400); after += 1; return "woke"; };
  const first = openDurable(file);
  first.register("flow", flow);
  first.startWorkflow("flow", "w1", {});
  await new Promise((r) => setTimeout(r, 100));
  await first.close();
  assert.equal(after, 0);

  const second = openDurable(file);
  second.register("flow", flow);
  const started = Date.now();
  second.recover();
  assert.equal(await second.result("w1"), "woke");
  const waited = Date.now() - started;
  assert.ok(waited < 360, `waited ${waited} ms after the restart; a fresh 400 ms sleep would take longer`);
  assert.equal(after, 1);
  await second.close();
});

test("startWorkflowOnce starts a workflow id once and returns null for a repeat", async () => {
  const log = openDurable(":memory:");
  let runs = 0;
  log.register("flow", async () => { runs += 1; return "done"; });
  const first = log.startWorkflowOnce("flow", "once", {});
  assert.equal(await first, "done");
  assert.equal(log.startWorkflowOnce("flow", "once", {}), null);
  assert.equal(runs, 1);
  await log.close();
});

test("prune deletes finished workflows older than the cut-off with their steps, and keeps pending ones", async () => {
  const log = openDurable(":memory:");
  log.register("flow", async (wf) => wf.step("a", () => 1));
  log.register("pending", async (wf) => wf.recv("never"));
  await log.startWorkflowOnce("flow", "done", {});
  log.startWorkflowOnce("pending", "waiting", {});
  assert.equal(log.prune(["flow", "pending"], Date.now() + 60_000), 1);
  assert.equal(log.status("done"), null);
  assert.equal(log.steps("done").length, 0);
  assert.equal(log.status("waiting").status, "PENDING");
  await log.close();
});

test("listNamed returns the newest workflows of one name with parsed input", async () => {
  const log = openDurable(":memory:");
  log.register("flow", async () => "ok");
  await log.startWorkflowOnce("flow", "a", { n: 1 });
  await log.startWorkflowOnce("flow", "b", { n: 2 });
  const rows = log.listNamed("flow", 10);
  assert.deepEqual(rows.map((r) => [r.id, r.status, r.input.n, r.output]).sort(), [["a", "SUCCESS", 1, "ok"], ["b", "SUCCESS", 2, "ok"]]);
  await log.close();
});
