import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig } from "../lib/config.mjs";
import { waitForReply } from "../lib/agents.mjs";
import { runCli } from "../lib/cli.mjs";
import { claimInbox, sendMessage } from "../lib/inbox.mjs";

// Stands in for the ntfy stream waiter: returns after a short pause, so the loop polls again.
const idleWait = async () => { await delay(20); return "event"; };

async function setup(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "alice", AI_COLLAB_PEERS: "alice,bob" });
  const alice = loadConfig(env);
  const bob = loadConfig(peerEnv(fake, { peer: "bob", AI_COLLAB_PEERS: env.AI_COLLAB_PEERS, AI_COLLAB_STATE_DIR: alice.stateDir }));
  return { alice, bob, env };
}

// Writes to a string.
function sink() {
  let text = "";
  return { write: (s) => { text += s; }, get text() { return text; } };
}

test("wait reply finds a reply that a hook already claimed", async (t) => {
  const { alice, bob } = await setup(t);
  const asked = await sendMessage(alice, "bob", "can you check?", { expectReply: true });
  await sendMessage(bob, "alice", "yes", { replyTo: asked.id, state: "done" });
  assert.equal((await claimInbox(alice)).length, 1, "the hook claims the reply");
  const got = await waitForReply(alice, asked.id, { awaitSeconds: 0, wait: idleWait });
  assert.equal(got.status, "replied");
  assert.equal(got.reply.state, "done");
});

test("wait reply finds the reply past more than 20 unread messages, and claims nothing", async (t) => {
  const { alice, bob } = await setup(t);
  const asked = await sendMessage(alice, "bob", "question");
  for (let i = 0; i < 25; i += 1) await sendMessage(bob, "alice", `chatter ${i}`);
  await sendMessage(bob, "alice", "the answer", { replyTo: asked.id, state: "reply" });
  const before = await claimInbox(alice, { commit: false, limit: 100 });
  const got = await waitForReply(alice, asked.id, { awaitSeconds: 0, wait: idleWait });
  assert.equal(got.status, "replied");
  assert.match(got.reply.body, /the answer/);
  const after = await claimInbox(alice, { commit: false, limit: 100 });
  assert.equal(after.length, before.length, "the unread cursor is untouched");
});

test("a working state or a reply to another id does not end the wait", async (t) => {
  const { alice, bob } = await setup(t);
  const asked = await sendMessage(alice, "bob", "question");
  await sendMessage(bob, "alice", "on it", { replyTo: asked.id, state: "working" });
  await sendMessage(bob, "alice", "other", { replyTo: "someoneelse", state: "reply" });
  const got = await waitForReply(alice, asked.id, { awaitSeconds: 0, wait: idleWait });
  assert.equal(got.status, "pending");
});

test("a malformed message id is rejected", async (t) => {
  const { alice } = await setup(t);
  await assert.rejects(waitForReply(alice, "bad id!", { awaitSeconds: 0, wait: idleWait }), /message id/);
});

test("the CLI exits 1 for an empty id and for no reply", async (t) => {
  const { env } = await setup(t);
  const out = sink();
  const err = sink();
  assert.equal(await runCli(["wait", "reply:"], { env, stdout: out, stderr: err }), 1);
  assert.match(err.text, /usage: wait reply:/);
  const quiet = sink();
  assert.equal(await runCli(["wait", "reply:m00000099", "0"], { env, stdout: quiet, stderr: sink() }), 1);
  assert.equal(quiet.text, "no reply yet\n");
});
