import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDurable } from "../runner/durable.mjs";
import { deliveryWorkflow } from "../runner/delivery.mjs";

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

test("a busy target is not sent another copy of an unanswered expect_reply message", async () => {
  const pushes = [];
  const freeAt = Date.now() + 300;
  // The target works on the first copy for 300 ms, 15 redeliver periods.
  const busy = async () => Date.now() < freeAt;
  const durable = openDurable(path.join(mkdtempSync(path.join(os.tmpdir(), "ai-collab-busy-")), "runner.db"));
  durable.register("delivery", deliveryWorkflow(deps(pushes, busy)));
  const output = await durable.startWorkflowOnce("delivery", "delivery:opencode#abc:m1", { project: "demo", address: SESSION.id, message });
  await durable.close();
  assert.equal(output.status, "dropped");
  assert.equal(pushes.length, 5);
  // No copy follows the first until the target frees up.
  assert.ok(pushes[1].at >= freeAt, "second copy went out while the target was busy");
});
