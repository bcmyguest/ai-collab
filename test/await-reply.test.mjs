import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig } from "../lib/config.ts";
import { awaitReply } from "../lib/agents.ts";
import { sendMessage } from "../lib/inbox.mjs";

// Stands in for the ntfy stream waiter: returns after a short pause, so the loop polls again.
const idleWait = async () => { await delay(20); return "timeout"; };

async function setup(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "alice", AI_COLLAB_PEERS: "alice,bob" });
  const alice = loadConfig(env);
  const bob = loadConfig(peerEnv(fake, { peer: "bob", AI_COLLAB_PEERS: env.AI_COLLAB_PEERS, AI_COLLAB_STATE_DIR: alice.stateDir }));
  return { alice, bob };
}

test("wait reply returns the answer to a message id, with its state", async (t) => {
  const { alice, bob } = await setup(t);
  const asked = await sendMessage(alice, "bob", "can you check this?", { expectReply: true });
  await sendMessage(bob, "alice", "yes", { replyTo: asked.id, state: "reply" });
  const got = await awaitReply(alice, asked.id, { awaitSeconds: 5, wait: idleWait });
  assert.equal(got.status, "replied");
  assert.equal(got.reply.replyTo, asked.id);
  assert.equal(got.reply.state, "reply");
  assert.match(got.reply.body, /yes/);
});

test("an answer to another id, or a working state, does not end the wait", async (t) => {
  const { alice, bob } = await setup(t);
  const asked = await sendMessage(alice, "bob", "question");
  await sendMessage(bob, "alice", "for someone else", { replyTo: "someoneelse", state: "reply" });
  await sendMessage(bob, "alice", "on it", { replyTo: asked.id, state: "working" });
  const got = await awaitReply(alice, asked.id, { awaitSeconds: 0, wait: idleWait });
  assert.equal(got.status, "pending");
  assert.match(got.note, /wait/);
});
