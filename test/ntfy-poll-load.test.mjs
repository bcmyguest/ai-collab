import assert from "node:assert/strict";
import { test } from "node:test";
import os from "node:os";
import { broadcastTopic, inboxTopic, loadConfig } from "../lib/config.ts";
import { claimInbox, reserveOwned } from "../lib/inbox.mjs";
import { pollCached } from "../lib/transport.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

// Captures stderr writes made while fn runs.
async function captureStderr(fn) {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    await fn();
  } finally {
    process.stderr.write = write;
  }
  return lines;
}

// One clock for the whole test, so the first-contact lookback is the same on every claim.
const NOW = Date.now();
const peerCfg = (fake, peer) => loadConfig(peerEnv(fake, { peer }), { cwd: os.tmpdir() });
const lastPoll = (fake, topic) => fake.state.polls.filter((p) => p.topic === topic).at(-1);

// Runs first: the once-per-process log line must not have fired in an earlier test.
test("the ntfy error code of a 429 is logged once per process", async () => {
  const fake = await startFakeNtfy();
  try {
    fake.state.limitNext = 2;
    const cfg = { url: fake.url, timeoutMs: 2000 };
    const lines = await captureStderr(async () => {
      await assert.rejects(pollCached(cfg, broadcastTopic("demo"), "all"));
      await assert.rejects(pollCached(cfg, broadcastTopic("demo"), "all"));
    });
    const logged = lines.filter((l) => l.includes("42905"));
    assert.equal(logged.length, 1);
    assert.match(logged[0], /ntfy HTTP 429 code 42905: limit reached: daily bandwidth reached/);
  } finally {
    await fake.close();
  }
});

test("a 429 poll fails at once with its HTTP status, without retrying", async () => {
  const fake = await startFakeNtfy();
  try {
    fake.state.limitNext = 1;
    const cfg = { url: fake.url, timeoutMs: 2000 };
    await assert.rejects(pollCached(cfg, broadcastTopic("demo"), "all"), (err) => err.ntfyStatus === 429);
    assert.equal(fake.state.polls.length, 1);
  } finally {
    await fake.close();
  }
});

test("a same-lane peek skips events its own predicate refused, and no further", async () => {
  const fake = await startFakeNtfy();
  try {
    const cfg = peerCfg(fake, "alice");
    const peek = { cursors: new Map(), lane: "wake" };
    for (const text of ["backlog-1", "backlog-2", "backlog-3"]) fake.inject(broadcastTopic("demo"), text);
    const refusedAll = () => false;
    assert.deepEqual(await claimInbox(cfg, { commit: false, accept: refusedAll, peek, poll: new Map(), now: NOW }), []);
    fake.inject(broadcastTopic("demo"), "fresh-4");
    const second = await claimInbox(cfg, { commit: false, peek, poll: new Map(), now: NOW });
    assert.deepEqual(second.map((m) => m.body), ["fresh-4"]);
    assert.match(lastPoll(fake, broadcastTopic("demo")).since, /^\d+$/, "second read starts at an event id");
  } finally {
    await fake.close();
  }
});

test("a peek on the wake lane does not hide a message from the live lane", async () => {
  const fake = await startFakeNtfy();
  try {
    const cfg = peerCfg(fake, "alice");
    const cursors = new Map();
    fake.inject(broadcastTopic("demo"), "refused-by-wake");
    const wake = await claimInbox(cfg, { commit: false, accept: () => false, peek: { cursors, lane: "wake" }, poll: new Map(), now: NOW });
    assert.deepEqual(wake, []);
    const live = await claimInbox(cfg, { commit: false, peek: { cursors, lane: "live" }, poll: new Map(), now: NOW });
    assert.deepEqual(live.map((m) => m.body), ["refused-by-wake"]);
  } finally {
    await fake.close();
  }
});

test("a claim that returns messages leaves the peek position alone", async () => {
  const fake = await startFakeNtfy();
  try {
    const cfg = peerCfg(fake, "alice");
    const peek = { cursors: new Map(), lane: "live" };
    fake.inject(broadcastTopic("demo"), "pending");
    const first = await claimInbox(cfg, { commit: false, peek, poll: new Map(), now: NOW });
    assert.deepEqual(first.map((m) => m.body), ["pending"]);
    const again = await claimInbox(cfg, { commit: false, peek, poll: new Map(), now: NOW });
    assert.deepEqual(again.map((m) => m.body), ["pending"], "the pending message is still offered");
  } finally {
    await fake.close();
  }
});

test("a committed cursor that moved since the peek wins over the peek", async () => {
  const fake = await startFakeNtfy();
  try {
    const cfg = peerCfg(fake, "alice");
    const peek = { cursors: new Map(), lane: "wake" };
    fake.inject(broadcastTopic("demo"), "e1");
    await claimInbox(cfg, { commit: false, accept: () => false, peek, poll: new Map(), now: NOW });
    const e2 = fake.inject(broadcastTopic("demo"), "e2");
    await claimInbox(cfg, { commit: true, now: NOW });
    await claimInbox(cfg, { commit: false, accept: () => false, peek, poll: new Map(), now: NOW });
    assert.equal(lastPoll(fake, broadcastTopic("demo")).since, e2.id);
  } finally {
    await fake.close();
  }
});

test("a reserved event stops the peek before it", async () => {
  const fake = await startFakeNtfy();
  try {
    const cfg = peerCfg(fake, "alice");
    const peek = { cursors: new Map(), lane: "wake" };
    const e1 = fake.inject(broadcastTopic("demo"), "e1");
    const e2 = fake.inject(broadcastTopic("demo"), "e2");
    await reserveOwned(cfg, [e2.id], { owner: "test", now: NOW, ttlMs: 60_000 });
    await claimInbox(cfg, { commit: false, accept: () => false, peek, poll: new Map(), now: NOW });
    await claimInbox(cfg, { commit: false, accept: () => false, peek, poll: new Map(), now: NOW });
    assert.equal(lastPoll(fake, broadcastTopic("demo")).since, e1.id);
  } finally {
    await fake.close();
  }
});

test("an error on one topic does not stop the other topic's peek", async () => {
  const fake = await startFakeNtfy();
  try {
    const cfg = peerCfg(fake, "alice");
    const peek = { cursors: new Map(), lane: "wake" };
    const e1 = fake.inject(broadcastTopic("demo"), "e1");
    fake.state.limitNext = 1; // the first poll is the inbox topic
    await claimInbox(cfg, { commit: false, accept: () => false, peek, poll: new Map(), now: NOW });
    await claimInbox(cfg, { commit: false, accept: () => false, peek, poll: new Map(), now: NOW });
    assert.equal(lastPoll(fake, broadcastTopic("demo")).since, e1.id);
    assert.equal(lastPoll(fake, inboxTopic("demo", "alice")).since, String(Math.floor(NOW / 1000) - 3600));
  } finally {
    await fake.close();
  }
});

test("sessions in one claim round share one poll per topic and read position", async () => {
  const fake = await startFakeNtfy();
  try {
    const alice = peerCfg(fake, "alice");
    const bob = peerCfg(fake, "bob");
    const poll = new Map();
    fake.inject(broadcastTopic("demo"), "shared");
    await claimInbox(alice, { commit: false, accept: () => false, poll, peek: { cursors: new Map(), lane: "wake" }, now: NOW });
    await claimInbox(bob, { commit: false, accept: () => false, poll, peek: { cursors: new Map(), lane: "wake" }, now: NOW });
    const reads = (topic) => fake.state.polls.filter((p) => p.topic === topic).length;
    assert.equal(reads(broadcastTopic("demo")), 1, "broadcast polled once for both sessions");
    assert.equal(reads(inboxTopic("demo", "alice")), 1);
    assert.equal(reads(inboxTopic("demo", "bob")), 1);
  } finally {
    await fake.close();
  }
});
