// Pins the behaviour of the messaging functions before they move to lib/messaging.ts: inputs, bus requests, outputs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { createBusServer, openMemoryStore } from "../lib/bus.mjs";
import { loadConfig } from "../lib/config.mjs";
import { claimInbox, parseEnvelope, sendMessage } from "../lib/inbox.mjs";
import { settleReceipts } from "../lib/receipts.mjs";
import { readInbox, waitUntil } from "../lib/messaging.ts";
import { pollCached, publish, querySafe, streamEvents } from "../lib/transport.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const PROJECT = "demo";
const INBOX_BOB = `ai-collab-${PROJECT}--to--bob`;
const RECEIPTS = `ai-collab-${PROJECT}--receipts`;

// Starts the production bus protocol on the memory store, recording each request the hooks observe.
async function startBus(t) {
  const store = openMemoryStore();
  const log = { publishes: [], polls: [], subscribes: [] };
  const bus = createBusServer({
    store,
    hooks: {
      onPublish: (rec) => log.publishes.push(rec),
      onPoll: (rec) => { log.polls.push(rec); return undefined; },
      onSubscribe: (rec) => log.subscribes.push(rec),
    },
  });
  const url = await bus.listen();
  t.after(async () => { await bus.close(); store.close(); });
  return { url, log };
}

function peer(url, name) {
  return loadConfig({
    PATH: process.env.PATH,
    HOME: os.tmpdir(),
    AI_COLLAB_URL: url,
    AI_COLLAB_PROJECT: PROJECT,
    AI_COLLAB_PEER: name,
    AI_COLLAB_PEERS: "alice,bob",
    AI_COLLAB_STATE_DIR: tempDir({ after }, "ai-collab-msg-"),
    AI_COLLAB_TIMEOUT_MS: "2000",
  });
}

test("sendMessage posts one msg envelope to the recipient inbox and resolves its topic and id", async (t) => {
  const { url, log } = await startBus(t);
  const alice = peer(url, "alice");
  const sent = await sendMessage(alice, "bob", "hello");
  assert.equal(sent.topic, INBOX_BOB);
  assert.equal(typeof sent.id, "string");
  assert.equal(log.publishes.length, 1);
  assert.equal(log.publishes[0].topic, INBOX_BOB);
  assert.equal(log.publishes[0].id, sent.id);
  assert.equal(log.publishes[0].title, "ai-collab from alice");
  const envelope = parseEnvelope(log.publishes[0].message);
  assert.equal(envelope.kind, "msg");
  assert.equal(envelope.from, "alice");
  assert.equal(envelope.to, "bob");
  assert.equal(envelope.body, "hello");
});

test("sendMessage rejects bad input before any bus request", async (t) => {
  const { url, log } = await startBus(t);
  const alice = peer(url, "alice");
  await assert.rejects(sendMessage(alice, "Bob!", "x"), { message: 'invalid peer name "Bob!"' });
  await assert.rejects(sendMessage(alice, "carol", "x"), { message: 'peer "carol" is not in AI_COLLAB_PEERS' });
  await assert.rejects(sendMessage(alice, "bob", "   "), { message: "empty message" });
  await assert.rejects(sendMessage(alice, "all", "x", { expectReply: true }), { message: "expect_reply needs a direct, non-fyi message" });
  await assert.rejects(sendMessage(alice, "bob", "x", { priority: "fyi", urgent: true }), { message: "a message cannot be both fyi and urgent" });
  await assert.rejects(sendMessage(alice, "bob", "x", { replyTo: "m1", state: "bogus" }), { message: "state must be working, reply, done or declined, with reply_to" });
  assert.equal(log.publishes.length, 0);
});

test("claimInbox returns a new message once, commits its cursor, and peeks without committing", async (t) => {
  const { url } = await startBus(t);
  const alice = peer(url, "alice");
  const bob = peer(url, "bob");
  const first = await sendMessage(alice, "bob", "first");
  const got = await claimInbox(bob, { strict: true, commit: false });
  assert.equal(got.length, 1);
  assert.equal(got[0].id, first.id);
  assert.equal(got[0].from, "alice");
  assert.equal(got[0].to, "bob");
  assert.equal(got[0].body, "first");
  assert.equal(typeof got[0].ts, "string");

  const peekedAgain = await claimInbox(bob, { strict: true, commit: false });
  assert.equal(peekedAgain.length, 1, "a peek leaves the message unread");

  const committed = await claimInbox(bob, { strict: true });
  assert.deepEqual(committed.map((m) => m.id), [first.id]);
  assert.deepEqual(await claimInbox(bob, { strict: true }), [], "a committed message is not returned again");
});

test("claimInbox applies accept before counting toward limit", async (t) => {
  const { url } = await startBus(t);
  const alice = peer(url, "alice");
  const bob = peer(url, "bob");
  await sendMessage(alice, "bob", "skip me");
  const keep = await sendMessage(alice, "bob", "keep me");
  const got = await claimInbox(bob, { strict: true, limit: 1, accept: (m) => m.body === "keep me" });
  assert.deepEqual(got.map((m) => m.id), [keep.id]);
});

test("readInbox publishes read receipts for claimed messages and none for a peek", async (t) => {
  const { url, log } = await startBus(t);
  const alice = peer(url, "alice");
  const bob = peer(url, "bob");
  const sent = await sendMessage(alice, "bob", "read me");

  const peeked = await readInbox(bob, { peek: true, strict: true });
  assert.deepEqual(peeked.map((m) => m.id), [sent.id]);
  await settleReceipts();
  assert.equal(log.publishes.filter((p) => p.topic === RECEIPTS).length, 0);

  const read = await readInbox(bob, { strict: true });
  assert.deepEqual(read.map((m) => m.id), [sent.id]);
  await settleReceipts();
  const receipts = log.publishes.filter((p) => p.topic === RECEIPTS);
  assert.equal(receipts.length, 1);
  assert.deepEqual(parseEnvelope(receipts[0].message).ids, [sent.id]);
});

test("pollCached returns message events oldest first with topic, id, time and message", async (t) => {
  const { url, log } = await startBus(t);
  const alice = peer(url, "alice");
  const sent = await sendMessage(alice, "bob", "poll me");
  const events = await pollCached(alice, INBOX_BOB, "all");
  assert.equal(events.length, 1);
  assert.equal(events[0].id, sent.id);
  assert.equal(events[0].topic, INBOX_BOB);
  assert.equal(events[0].message, log.publishes[0].message);
  assert.equal(typeof events[0].time, "number");
  assert.equal(log.polls.at(-1).topic, INBOX_BOB);
  assert.equal(log.polls.at(-1).since, "all");
});

test("publish resolves the new event id and passes the published event to onPublished", async (t) => {
  const { url } = await startBus(t);
  const alice = peer(url, "alice");
  const seen = [];
  const id = await publish(alice, "ai-collab-demo--activity", "plain text", { title: "t", onPublished: (ev) => seen.push(ev) });
  assert.equal(typeof id, "string");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, id);
  assert.equal(seen[0].topic, "ai-collab-demo--activity");
  assert.equal(seen[0].message, "plain text");
  assert.equal(seen[0].title, "t");
});

test("querySafe respells \\n and \\\\ in JSON messages and leaves other text alone", () => {
  const json = '{"m":"a\\nb\\\\c"}';
  assert.equal(querySafe(json), '{"m":"a\\u000ab\\u005cc"}');
  assert.equal(querySafe("a\\nb"), "a\\nb");
});

test("streamEvents replays from a known since, and reports reset once for an unknown since", async (t) => {
  const { url, log } = await startBus(t);
  const alice = peer(url, "alice");
  await sendMessage(alice, "bob", "one");
  await sendMessage(alice, "bob", "two");
  const collect = async (since, onReset) => {
    const out = [];
    for await (const ev of streamEvents(alice, [INBOX_BOB], { since, onReset })) {
      out.push(ev.message);
      if (out.length === 2) break;
    }
    return out;
  };
  let resets = 0;
  const known = await collect("all", () => { resets += 1; });
  assert.equal(known.length, 2);
  assert.equal(resets, 0);
  assert.equal(log.subscribes.at(-1).since, "all");
  const unknown = await collect("999999", () => { resets += 1; });
  assert.equal(unknown.length, 2);
  assert.equal(resets, 1);
});

test("waitUntil returns hit, timeout, aborted or queued", async () => {
  const hit = await waitUntil({ deadline: Date.now() + 1000, until: async () => "v" });
  assert.deepEqual(hit, { status: "hit", value: "v" });

  const past = await waitUntil({ deadline: 0, now: () => 1, until: async () => undefined });
  assert.deepEqual(past, { status: "timeout" });

  const ac = new AbortController();
  ac.abort();
  const aborted = await waitUntil({ deadline: Date.now() + 1000, signal: ac.signal, until: async () => undefined });
  assert.deepEqual(aborted, { status: "aborted" });

  const queued = await waitUntil({ deadline: Date.now() + 1000, until: async () => undefined, stream: async () => "queued" });
  assert.deepEqual(queued, { status: "queued" });
});

test("waitUntil re-checks until after each poll sleep and skips the first check when checkFirst is false", async () => {
  const calls = [];
  let n = 0;
  const polled = await waitUntil({
    deadline: Date.now() + 10_000,
    poll: { intervalMs: 1, sleep: async () => {} },
    until: async (first) => { calls.push(first); n += 1; return n === 2 ? "ok" : undefined; },
  });
  assert.deepEqual(polled, { status: "hit", value: "ok" });
  assert.deepEqual(calls, [true, false]);

  const skipped = [];
  const later = await waitUntil({
    deadline: Date.now() + 10_000,
    checkFirst: false,
    poll: { intervalMs: 1, sleep: async () => {} },
    until: async (first) => { skipped.push(first); return skipped.length === 2 ? "late" : undefined; },
  });
  assert.deepEqual(later, { status: "hit", value: "late" });
  assert.deepEqual(skipped, [false, false]);
});
