import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openDurable } from "../lib/durable.ts";
import { deliveryWorkflow } from "../runner/delivery.ts";
import { tempDir } from "./helpers/tmp.mjs";

const SESSION = { id: "opencode#abc", harness: "opencode", sessionId: "ses_1", online: true, peer: "opencode", session: "abc" };
const message = { id: "m1", from: "claude#def", body: "hi", expectReply: true };

// Deps that record pushes; busy(session) reports whether the target still works on an earlier push.
function deps(pushes, busy) {
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
    acked: async () => false,
    textFor: (scfg, m, attempt) => `${m.id} attempt ${attempt}`,
    backoffMs: () => 5,
    redeliverMs: 20,
    readyPollMs: 5,
  };
}

test("a busy target is not sent another copy of an unanswered expect_reply message", async (t) => {
  const pushes = [];
  const freeAt = Date.now() + 300;
  // The target works on the first copy for 300 ms, 15 redeliver periods.
  const busy = async () => Date.now() < freeAt;
  const durable = openDurable(path.join(tempDir(t, "ai-collab-busy-"), "runner.db"));
  durable.register("delivery", deliveryWorkflow(deps(pushes, busy)));
  const output = await durable.startWorkflowOnce("delivery", "delivery:opencode#abc:m1", { project: "demo", address: SESSION.id, message });
  await durable.close();
  assert.equal(output.status, "dropped");
  assert.equal(pushes.length, 5);
  // No copy follows the first until the target frees up.
  assert.ok(pushes[1].at >= freeAt, "second copy went out while the target was busy");
});

test("each target poll probes the live set once and passes it to ready and busy", async (t) => {
  const pushes = [];
  const start = Date.now();
  const probes = [];
  const readyArgs = [];
  const busyArgs = [];
  const probe = async () => {
    const active = new Set([SESSION.sessionId]);
    probes.push(active);
    return active;
  };
  const deps2 = {
    ...deps(pushes, async () => Date.now() < start + 200),
    probe,
    ready: async (session, active) => { readyArgs.push(active); return true; },
    busy: async (session, active) => { busyArgs.push(active); return Date.now() < start + 200; },
    acked: async () => false,
  };
  const durable = openDurable(path.join(tempDir(t, "ai-collab-busy-"), "runner.db"));
  durable.register("delivery", deliveryWorkflow(deps2));
  await durable.startWorkflowOnce("delivery", "delivery:opencode#abc:m1", { project: "demo", address: SESSION.id, message });
  await durable.close();
  assert.ok(busyArgs.length > 1, "busy wait ran no poll");
  assert.equal(probes.length, readyArgs.length, "one probe per poll");
  assert.ok(busyArgs.every((active, i) => active === readyArgs[i + 1]), "busy got a different probe than ready");
});

test("an answer during the busy wait ends redelivery with no further copy", async (t) => {
  const pushes = [];
  const start = Date.now();
  const busy = async () => Date.now() < start + 300;
  const answerAt = start + 100;
  const durable = openDurable(path.join(tempDir(t, "ai-collab-busy-"), "runner.db"));
  durable.register("delivery", deliveryWorkflow({ ...deps(pushes, busy), acked: async () => Date.now() >= answerAt }));
  const output = await durable.startWorkflowOnce("delivery", "delivery:opencode#abc:m1", { project: "demo", address: SESSION.id, message });
  await durable.close();
  assert.equal(output.status, "answered");
  assert.equal(pushes.length, 1);
});
