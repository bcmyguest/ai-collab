import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { broadcastTopic, inboxTopic, loadConfig, receiptsTopic } from "../lib/config.mjs";
import { claimInbox, sendMessage } from "../lib/inbox.mjs";
import { respond } from "../lib/agents.mjs";
import { ackTracker } from "../lib/deliver-push.mjs";

const PEERS = "alice,claude,opencode";

async function setup(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const base = peerEnv(fake, { peer: "claude", AI_COLLAB_PEERS: PEERS });
  const sender = loadConfig(base, { session: "77f66303d04fef9d" });
  const target = loadConfig({ ...base, AI_COLLAB_PEER: "opencode" }, { session: "79f30a4e46706223" });
  const address = "opencode#79f30a4e46706223";
  const sent = await sendMessage(sender, address, "need an answer", { expectReply: true });
  // The runner's topics for this delivery: receipts, broadcast, the target's inbox and the sender's inbox.
  const topics = new Set([receiptsTopic(sender.project), broadcastTopic(sender.project), inboxTopic(sender.project, "opencode"), inboxTopic(sender.project, "claude")]);
  return { sender, target, address, sent, topics, tracker: ackTracker() };
}

for (const state of ["reply", "done"]) {
  test(`a send with reply_to and state=${state} stops expect_reply redelivery`, async (t) => {
    const { sender, target, address, sent, topics, tracker } = await setup(t);
    await tracker.refresh(sender, topics);
    assert.equal(tracker.acked(sent.id, address), false);
    await sendMessage(target, "claude#77f66303d04fef9d", "answered", { replyTo: sent.id, state });
    await tracker.refresh(sender, topics);
    assert.equal(tracker.acked(sent.id, address), true);
  });
}

test("respond by message_id stops expect_reply redelivery", async (t) => {
  const { sender, target, address, sent, topics, tracker } = await setup(t);
  assert.equal((await claimInbox(target)).length, 1);
  await tracker.refresh(sender, topics);
  await respond(target, sent.id, "done", "finished");
  await tracker.refresh(sender, topics);
  assert.equal(tracker.acked(sent.id, address), true);
});
