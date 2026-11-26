import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDurable } from "../runner/durable.mjs";
import { deliveryWorkflow } from "../runner/delivery.mjs";

const dbFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), "ai-collab-delivery-")), "runner.db");
const SESSION = { id: "codex#abc", harness: "codex", sessionId: "t1", online: true, peer: "codex", session: "abc" };
const message = (over = {}) => ({ id: "m1", from: "operator", body: "hi", ...over });

// Deps that record every push, mark and release into log. over replaces any dep; statuses feeds push results in order.
function depsWith(log, over = {}) {
  const statuses = over.statuses ?? [];
  return {
    now: () => Date.now(),
    scfgOf: () => ({ project: "demo", peer: "codex", session: "abc" }),
    sessionOf: () => SESSION,
    ready: async () => true,
    reserve: async (scfg, ids) => ({ owned: ids, busy: false }),
    release: async () => { log.releases += 1; },
    markDelivered: async () => { log.marks += 1; },
    snapshot: async () => { log.snapshots += 1; return null; },
    push: async (session, { text }) => { log.pushes.push(text); return { status: statuses.shift() ?? "delivered" }; },
    awaitConfirm: async () => true,
    confirmedSince: async () => false,
    waitConfirmed: async () => false,
    acked: async () => false,
    textFor: (scfg, m, attempt) => `${m.id} attempt ${attempt}`,
    backoffMs: () => 5,
    redeliverMs: 20,
    readyPollMs: 5,
    ...over,
  };
}
const newLog = () => ({ pushes: [], marks: 0, releases: 0, snapshots: 0 });

// Starts one delivery in a fresh log and resolves its output once it ends.
async function deliver(deps, { file = dbFile(), msg = message(), durable = openDurable(file) } = {}) {
  durable.register("delivery", deliveryWorkflow(deps));
  const run = durable.startWorkflowOnce("delivery", `delivery:${SESSION.id}:${msg.id}`, { project: "demo", address: SESSION.id, message: msg });
  const output = await run;
  await durable.close();
  return { output, file };
}

test("a delivered message is pushed once, marked delivered, and its workflow ends delivered", async () => {
  const log = newLog();
  const { output, file } = await deliver(depsWith(log));
  assert.deepEqual(output, { status: "delivered", pushes: 1 });
  assert.deepEqual(log.pushes, ["m1 attempt 1"]);
  assert.equal(log.marks, 1);
  assert.equal(openDurable(file).status(`delivery:${SESSION.id}:m1`).status, "SUCCESS");
});

test("an unsent push releases the reservation, waits the backoff, and pushes again", async () => {
  const log = newLog();
  const { output } = await deliver(depsWith(log, { statuses: ["unsent"] }));
  assert.deepEqual(output, { status: "delivered", pushes: 1 });
  assert.equal(log.pushes.length, 2);
  assert.equal(log.releases, 1);
});

test("an unconfirmed push is resent only after the late check finds no confirmation", async () => {
  const log = newLog();
  const { output } = await deliver(depsWith(log, { statuses: ["unconfirmed", "delivered"], awaitConfirm: async () => false }));
  assert.equal(output.status, "delivered");
  assert.equal(log.pushes.length, 2);
  assert.equal(log.releases, 1);
});

test("a late confirmation after an unconfirmed push marks the message delivered with no second send", async () => {
  const log = newLog();
  const { output } = await deliver(depsWith(log, { statuses: ["unconfirmed"], awaitConfirm: async () => false, confirmedSince: async () => true }));
  assert.equal(output.status, "delivered");
  assert.equal(log.pushes.length, 1);
  assert.equal(log.releases, 0);
});

test("a push cut by a restart is never resent when the transcript shows it landed", async () => {
  const file = dbFile();
  const log = newLog();
  let stop;
  const hang = { push: (s, { text }) => { log.pushes.push(text); return new Promise((_, reject) => { stop = reject; }); } };
  const first = openDurable(file);
  first.register("delivery", deliveryWorkflow(depsWith(log, hang)));
  first.startWorkflow("delivery", "delivery:x", { project: "demo", address: SESSION.id, message: message() });
  await new Promise((r) => setTimeout(r, 30));
  const closing = first.close();
  stop(new Error("runner stopped"));
  await closing;

  const second = openDurable(file);
  second.register("delivery", deliveryWorkflow(depsWith(log, { waitConfirmed: async () => true })));
  second.recover();
  assert.deepEqual(await second.result("delivery:x"), { status: "delivered", pushes: 1 });
  assert.equal(log.pushes.length, 1);
  await second.close();
});

test("a push cut by a restart and not shown in the transcript is marked cut and never resent", async () => {
  const file = dbFile();
  const log = newLog();
  let stop;
  const hang = { push: (s, { text }) => { log.pushes.push(text); return new Promise((_, reject) => { stop = reject; }); } };
  const first = openDurable(file);
  first.register("delivery", deliveryWorkflow(depsWith(log, hang)));
  first.startWorkflow("delivery", "delivery:x", { project: "demo", address: SESSION.id, message: message() });
  await new Promise((r) => setTimeout(r, 30));
  const closing = first.close();
  stop(new Error("runner stopped"));
  await closing;

  const second = openDurable(file);
  second.register("delivery", deliveryWorkflow(depsWith(log, { waitConfirmed: async () => false })));
  second.recover();
  assert.deepEqual(await second.result("delivery:x"), { status: "cut" });
  assert.equal(log.pushes.length, 1);
  // Unconfirmed after the full window: released to the hooks, never marked seen, never sent again.
  assert.equal(log.marks, 0);
  assert.equal(log.releases, 1);
  await second.close();
});

test("an expect-reply message is redelivered as attempt 2 to 5, then dropped", async () => {
  const log = newLog();
  const { output } = await deliver(depsWith(log), { msg: message({ expectReply: true }) });
  assert.deepEqual(output, { status: "dropped", pushes: 5 });
  assert.deepEqual(log.pushes, ["m1 attempt 1", "m1 attempt 2", "m1 attempt 3", "m1 attempt 4", "m1 attempt 5"]);
});

test("an expect-reply message stops being redelivered once the target answers", async () => {
  const log = newLog();
  let checks = 0;
  const { output } = await deliver(depsWith(log, { acked: async () => (checks += 1) >= 2 }), { msg: message({ expectReply: true }) });
  // The second check runs right before the redelivery and finds the answer, so no copy goes out (operator-approved 2026-11-25).
  assert.deepEqual(output, { status: "answered", pushes: 1 });
  assert.equal(log.pushes.length, 1);
});

test("a message already reserved elsewhere is skipped without a push", async () => {
  const log = newLog();
  const { output } = await deliver(depsWith(log, { reserve: async () => ({ owned: [], busy: false }) }));
  assert.deepEqual(output, { status: "skipped" });
  assert.equal(log.pushes.length, 0);
});

test("a message waits while its session is not ready, then goes out", async () => {
  const log = newLog();
  let polls = 0;
  const { output } = await deliver(depsWith(log, { ready: async () => (polls += 1) >= 3 }));
  assert.equal(output.status, "delivered");
  assert.equal(polls, 3);
  assert.equal(log.pushes.length, 1);
});

test("a busy inbox lock is retried after backoff, not taken as a skip", async () => {
  const log = newLog();
  let reserves = 0;
  const { output } = await deliver(depsWith(log, {
    reserve: async (scfg, ids) => (reserves += 1) === 1 ? { owned: [], busy: true } : { owned: ids, busy: false },
  }));
  assert.equal(output.status, "delivered");
  assert.equal(reserves, 2);
  assert.equal(log.pushes.length, 1);
});

test("the first snapshot is kept across attempts, so every resend is checked against it", async () => {
  const log = newLog();
  const { output } = await deliver(depsWith(log, { statuses: ["unsent", "unsent", "delivered"] }));
  assert.equal(output.status, "delivered");
  assert.equal(log.pushes.length, 3);
  assert.equal(log.snapshots, 1);
});
