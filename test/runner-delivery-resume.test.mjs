// Regression for the gap TLC found in spec/tla/Delivery.tla (ResumeChecks = FALSE): a restart between a redelivery's
// reserve step and its push step replayed the attempt without its checks and pushed to a busy or answered target.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openDurable } from "../runner/durable.mjs";
import { deliveryWorkflow } from "../runner/delivery.ts";
import { tempDir } from "./helpers/tmp.mjs";

const SESSION = { id: "opencode#abc", harness: "opencode", sessionId: "ses_1", online: true, peer: "opencode", session: "abc" };
const MESSAGE = { id: "m1", from: "claude#def", body: "hi", expectReply: true };
const ID = "delivery:opencode#abc:m1";

function deps(pushes, { busy = async () => false, acked = async () => false, textFor } = {}) {
  return {
    now: () => Date.now(),
    scfgOf: () => ({ project: "demo", peer: "opencode", session: "abc" }),
    sessionOf: () => SESSION,
    ready: async () => true,
    busy,
    reserve: async (scfg, ids) => ({ owned: ids, busy: false }),
    release: async () => {},
    markDelivered: async () => {},
    snapshot: async () => null,
    push: async (session, { text }) => { pushes.push({ text, at: Date.now() }); return { status: "delivered" }; },
    awaitConfirm: async () => true,
    confirmedSince: async () => false,
    waitConfirmed: async () => false,
    acked,
    textFor: textFor ?? ((scfg, m, attempt) => `${m.id} attempt ${attempt}`),
    backoffMs: () => 5,
    redeliverMs: 20,
    readyPollMs: 5,
  };
}

// Runs the first push, then crashes the runner after the second attempt's reserve step, before its push step.
async function crashBeforeSecondPush(t, pushes) {
  const db = path.join(tempDir(t, "ai-collab-resume-"), "runner.db");
  const durable = openDurable(db);
  let closing = null;
  const textFor = (scfg, m, attempt) => {
    if (attempt === 2) {
      closing = durable.close();
      throw new Error("runner killed");
    }
    return `${m.id} attempt ${attempt}`;
  };
  durable.register("delivery", deliveryWorkflow(deps(pushes, { textFor })));
  await durable.startWorkflowOnce("delivery", ID, { project: "demo", address: SESSION.id, message: MESSAGE });
  await closing;
  assert.equal(pushes.length, 1);
  return db;
}

test("an answer during a restart before the push step ends redelivery with no copy", async (t) => {
  const pushes = [];
  const db = await crashBeforeSecondPush(t, pushes);
  const durable = openDurable(db);
  durable.register("delivery", deliveryWorkflow(deps(pushes, { acked: async () => true })));
  assert.deepEqual(durable.recover(), [ID]);
  const output = await durable.result(ID);
  await durable.close();
  assert.equal(output.status, "answered");
  assert.equal(pushes.length, 1);
});

test("a target that turned busy during a restart before the push step gets no copy until it is idle", async (t) => {
  const pushes = [];
  const db = await crashBeforeSecondPush(t, pushes);
  const freeAt = Date.now() + 200;
  const durable = openDurable(db);
  durable.register("delivery", deliveryWorkflow(deps(pushes, { busy: async () => Date.now() < freeAt })));
  durable.recover();
  const output = await durable.result(ID);
  await durable.close();
  assert.equal(output.status, "dropped");
  assert.ok(pushes[1].at >= freeAt, "the resumed push went to a busy target");
});
