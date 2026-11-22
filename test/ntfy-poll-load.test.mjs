import assert from "node:assert/strict";
import { test } from "node:test";
import os from "node:os";
import { broadcastTopic, inboxTopic, loadConfig } from "../lib/config.mjs";
import { claimInbox } from "../lib/inbox.mjs";
import { pollCached } from "../lib/ntfy.mjs";
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

test("the ntfy error code of a 429 is logged once per process", async () => {
  const fake = await startFakeNtfy();
  try {
    fake.state.limitNext = 2;
    const cfg = { url: fake.url, timeoutMs: 2000 };
    const lines = await captureStderr(() => pollCached(cfg, broadcastTopic("demo"), "all"));
    const logged = lines.filter((l) => l.includes("42905"));
    assert.equal(logged.length, 1);
    assert.match(logged[0], /ntfy HTTP 429 code 42905: limit reached: daily bandwidth reached/);
  } finally {
    await fake.close();
  }
});

test("a 429 poll retries with backoff and returns the events", async () => {
  const fake = await startFakeNtfy();
  try {
    fake.inject(broadcastTopic("demo"), "one");
    fake.state.limitNext = 1;
    const cfg = { url: fake.url, timeoutMs: 2000 };
    const events = await pollCached(cfg, broadcastTopic("demo"), "all");
    assert.equal(events.length, 1);
    assert.equal(fake.state.polls.length, 2, "one 429 then one 200");
  } finally {
    await fake.close();
  }
});

test("a 429 that persists fails with the HTTP status after the retries", async () => {
  const fake = await startFakeNtfy();
  try {
    fake.state.limitNext = 99;
    const cfg = { url: fake.url, timeoutMs: 2000 };
    await assert.rejects(pollCached(cfg, broadcastTopic("demo"), "all"), (err) => err.ntfyStatus === 429);
    assert.equal(fake.state.polls.length, 3, "first try plus two retries");
  } finally {
    await fake.close();
  }
});

test("an idle claim reads from where its last peek stopped", async () => {
  const fake = await startFakeNtfy();
  try {
    const cfg = loadConfig(peerEnv(fake, { peer: "alice" }), { cwd: os.tmpdir() });
    const peek = new Map();
    for (const text of ["backlog-1", "backlog-2", "backlog-3"]) fake.inject(broadcastTopic("demo"), text);
    // Every event examined and rejected: nothing returned, so the peek position moves to the newest one.
    const first = await claimInbox(cfg, { commit: false, accept: () => false, peek, poll: new Map() });
    assert.deepEqual(first, []);
    fake.inject(broadcastTopic("demo"), "fresh-4");
    const second = await claimInbox(cfg, { commit: false, peek, poll: new Map() });
    assert.deepEqual(second.map((m) => m.body), ["fresh-4"]);
    const lastAll = fake.state.polls.filter((p) => p.topic === broadcastTopic("demo")).at(-1);
    assert.match(lastAll.since, /^m\d{8}$/, "second read starts at an event id, not the lookback");
  } finally {
    await fake.close();
  }
});

test("a claim that returns messages leaves the committed read position alone", async () => {
  const fake = await startFakeNtfy();
  try {
    const cfg = loadConfig(peerEnv(fake, { peer: "alice" }), { cwd: os.tmpdir() });
    const peek = new Map();
    fake.inject(broadcastTopic("demo"), "pending");
    const first = await claimInbox(cfg, { commit: false, peek, poll: new Map() });
    assert.deepEqual(first.map((m) => m.body), ["pending"]);
    const again = await claimInbox(cfg, { commit: false, peek, poll: new Map() });
    assert.deepEqual(again.map((m) => m.body), ["pending"], "the pending message is still offered");
  } finally {
    await fake.close();
  }
});

test("sessions in one tick share one poll per topic and read position", async () => {
  const fake = await startFakeNtfy();
  try {
    const alice = loadConfig(peerEnv(fake, { peer: "alice" }), { cwd: os.tmpdir() });
    const bob = loadConfig(peerEnv(fake, { peer: "bob" }), { cwd: os.tmpdir() });
    const poll = new Map();
    fake.inject(broadcastTopic("demo"), "shared");
    await claimInbox(alice, { commit: false, accept: () => false, poll, peek: new Map() });
    await claimInbox(bob, { commit: false, accept: () => false, poll, peek: new Map() });
    const reads = (topic) => fake.state.polls.filter((p) => p.topic === topic).length;
    assert.equal(reads(broadcastTopic("demo")), 1, "broadcast polled once for both sessions");
    assert.equal(reads(inboxTopic("demo", "alice")), 1);
    assert.equal(reads(inboxTopic("demo", "bob")), 1);
  } finally {
    await fake.close();
  }
});
