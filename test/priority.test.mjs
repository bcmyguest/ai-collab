import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig } from "../lib/config.mjs";
import { claimInbox, markDelivered, parseEnvelope, sendMessage } from "../lib/inbox.mjs";
import { formatInbox } from "../lib/format.mjs";

async function setup(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const alice = loadConfig(peerEnv(fake, { peer: "alice" }));
  const bob = loadConfig(peerEnv(fake, { peer: "bob" }));
  return { fake, alice, bob };
}

test("sendMessage carries priority fyi and expectReply into the envelope and the claimed message", async (t) => {
  const { fake, alice, bob } = await setup(t);
  await sendMessage(bob, "alice", "low", { priority: "fyi" });
  await sendMessage(bob, "alice", "answer me", { expectReply: true });
  await sendMessage(bob, "alice", "now", { priority: "urgent" });
  const sent = fake.state.publishes.map((p) => parseEnvelope(p.message));
  assert.equal(sent[0].priority, "fyi");
  assert.equal(sent[1].expectReply, true);
  assert.equal(sent[2].urgent, true);
  const got = await claimInbox(alice);
  assert.deepEqual(got.map((m) => [m.priority, m.expectReply, m.urgent]), [["fyi", undefined, undefined], [undefined, true, undefined], [undefined, undefined, true]]);
});

test("sendMessage rejects contradictory or unsupported priority and expectReply", async (t) => {
  const { bob } = await setup(t);
  await assert.rejects(sendMessage(bob, "alice", "x", { priority: "loud" }), /priority must be/);
  await assert.rejects(sendMessage(bob, "alice", "x", { priority: "fyi", urgent: true }), /both fyi and urgent/);
  await assert.rejects(sendMessage(bob, "all", "x", { expectReply: true }), /direct/);
  await assert.rejects(sendMessage(bob, "alice", "x", { priority: "fyi", expectReply: true }), /non-fyi/);
});

test("formatInbox tells the reader a reply is awaited and counts redelivery attempts", () => {
  const base = { id: "m1", from: "bob", to: "alice", ts: "", body: "do it", expectReply: true };
  assert.match(formatInbox([base]), /The sender is waiting for your reply: answer with respond message_id=m1/);
  assert.doesNotMatch(formatInbox([base]), /attempt/);
  assert.match(formatInbox([{ ...base, attempt: 2, attempts: 5 }]), /attempt 2 of 5/);
});

test("markDelivered makes later claims skip a message another path delivered", async (t) => {
  const { alice, bob } = await setup(t);
  await sendMessage(bob, "alice", "one");
  const [m] = await claimInbox(alice, { commit: false });
  await markDelivered(alice, [m.id]);
  assert.deepEqual(await claimInbox(alice), []);
});
