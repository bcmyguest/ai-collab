import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { broadcastTopic, inboxTopic, sessionLabel } from "../lib/config.ts";
import { claimInbox, reserveOwned } from "../lib/inbox.mjs";
import { recordSession } from "../lib/sessions.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { makeRunner, procStart, setup } from "./helpers/runner-ctx.mjs";

// Closed claude sessions of one peer: each takes the wake path, so each pump tick makes one claim per session.
async function claudeSessions(ctx, count = 2) {
  const nativeIds = Array.from({ length: count }, () => randomUUID());
  for (const id of nativeIds) {
    await recordSession({ ...ctx.cfg, peer: "claude", session: sessionLabel(id) }, { id, cwd: ctx.root, harness: "claude", event: "stop" });
  }
  return nativeIds.map(sessionLabel);
}

// A claude session whose process is this test process, so the pump sees it online.
async function onlineClaudeSession(ctx) {
  const id = randomUUID();
  await recordSession({ ...ctx.cfg, peer: "claude", session: sessionLabel(id) }, { id, cwd: ctx.root, harness: "claude", event: "stop", proc: { pid: process.pid, start: procStart(process.pid) } });
  return sessionLabel(id);
}

// A claim spy that records its options and runs the real claimInbox, so the pump's arguments reach the ntfy reads.
function spyClaim() {
  const calls = [];
  const claim = (cfg, opts) => {
    calls.push(opts);
    return claimInbox(cfg, opts);
  };
  return { calls, claim };
}

const polls = (fake, topic) => fake.state.polls.filter((p) => p.topic === topic);

test("a pump tick passes one shared poll memo and one peek map to every claim", async () => {
  const fake = await startFakeNtfy();
  try {
    const ctx = setup(fake);
    const spy = spyClaim();
    const { runner } = makeRunner(ctx, [], { delivery: { claim: spy.claim } });
    await claudeSessions(ctx);
    await runner.pump();
    assert.equal(spy.calls.length, 2);
    assert.ok(spy.calls[0].poll instanceof Map, "claim gets the tick's poll memo");
    assert.equal(spy.calls[0].poll, spy.calls[1].poll, "both sessions share one memo");
    assert.equal(spy.calls[0].peek.cursors, spy.calls[1].peek.cursors);
    assert.equal(spy.calls[0].peek.lane, "wake");
    assert.equal(polls(fake, broadcastTopic("demo")).length, 1, "broadcast polled once for the tick");
  } finally {
    await fake.close();
  }
});

test("a 429 skips that topic for the rest of the tick, then pauses whole ticks", async () => {
  const fake = await startFakeNtfy();
  try {
    const ctx = setup(fake);
    const spy = spyClaim();
    const { runner } = makeRunner(ctx, [], { delivery: { claim: spy.claim } });
    await claudeSessions(ctx);
    fake.state.limitNext = 1; // the first poll of the tick is the claude inbox topic
    await runner.pump();
    assert.equal(polls(fake, inboxTopic("demo", "claude")).length, 1, "the limited inbox topic is not read again");
    assert.equal(polls(fake, broadcastTopic("demo")).length, 1);
    const claimsAfterTick = spy.calls.length;
    await runner.pump();
    assert.equal(spy.calls.length, claimsAfterTick, "the next tick is skipped");
    await runner.pump();
    assert.ok(spy.calls.length > claimsAfterTick, "the tick after the pause runs");
  } finally {
    await fake.close();
  }
});

test("overlapping pump calls return at once without claiming", async () => {
  const fake = await startFakeNtfy();
  try {
    const ctx = setup(fake);
    const spy = spyClaim();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const gated = (cfg, opts) => spy.claim(cfg, opts).then(async (v) => { await gate; return v; });
    const { runner } = makeRunner(ctx, [], { delivery: { claim: gated } });
    await claudeSessions(ctx);
    const first = runner.pump();
    const timeout = new Promise((resolve) => setTimeout(() => resolve("blocked"), 500));
    try {
      const overlapping = await Promise.race([runner.pump(), timeout]);
      assert.deepEqual(overlapping, []);
      assert.equal(spy.calls.length, 1, "only the first tick claimed; it is blocked on its first claim");
    } finally {
      release();
    }
    await first;
    assert.equal(spy.calls.length, 2, "the first tick claimed each session once");
  } finally {
    await fake.close();
  }
});

test("a committed cursor that moved under a pump peek wins over the peek", async () => {
  const fake = await startFakeNtfy();
  try {
    const ctx = setup(fake);
    const { runner } = makeRunner(ctx, [], { delivery: {} });
    const [label] = await claudeSessions(ctx, 1);
    const scfg = { ...ctx.cfg, peer: "claude", session: label };
    fake.inject(broadcastTopic("demo"), "e1");
    await runner.pump();
    const e2 = fake.inject(broadcastTopic("demo"), "e2");
    await claimInbox(scfg, { commit: true });
    await runner.pump();
    assert.equal(polls(fake, broadcastTopic("demo")).at(-1).since, e2.id);
  } finally {
    await fake.close();
  }
});

test("a reserved event stops the pump peek before it", async () => {
  const fake = await startFakeNtfy();
  try {
    const ctx = setup(fake);
    const { runner } = makeRunner(ctx, [], { delivery: {} });
    const [label] = await claudeSessions(ctx, 1);
    const scfg = { ...ctx.cfg, peer: "claude", session: label };
    const e1 = fake.inject(broadcastTopic("demo"), "e1");
    const e2 = fake.inject(broadcastTopic("demo"), "e2");
    await reserveOwned(scfg, [e2.id], { owner: "test", ttlMs: 60_000 });
    await runner.pump();
    assert.notEqual(e1.id, e2.id);
    await runner.pump();
    assert.equal(polls(fake, broadcastTopic("demo")).at(-1).since, e1.id);
  } finally {
    await fake.close();
  }
});

test("an error on one topic leaves the other topic's pump peek in place", async () => {
  const fake = await startFakeNtfy();
  try {
    const ctx = setup(fake);
    const { runner } = makeRunner(ctx, [], { delivery: {} });
    await claudeSessions(ctx);
    const e1 = fake.inject(broadcastTopic("demo"), "e1");
    fake.state.limitNext = 1;
    await runner.pump();
    // Tick 1 meets the 429, tick 2 is paused, tick 3 reads again.
    await runner.pump();
    await runner.pump();
    assert.equal(polls(fake, broadcastTopic("demo")).at(-1).since, e1.id);
  } finally {
    await fake.close();
  }
});

test("an online session is claimed on the live lane with the tick's shared memo", async () => {
  const fake = await startFakeNtfy();
  try {
    const ctx = setup(fake);
    const spy = spyClaim();
    const { runner } = makeRunner(ctx, [], { delivery: { claim: spy.claim } });
    await onlineClaudeSession(ctx);
    await runner.pump();
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].peek.lane, "live");
    assert.ok(spy.calls[0].poll instanceof Map);
  } finally {
    await fake.close();
  }
});

test("the live and wake lanes keep separate pump peeks", async () => {
  const fake = await startFakeNtfy();
  try {
    const ctx = setup(fake);
    const spy = spyClaim();
    const { runner } = makeRunner(ctx, [], { delivery: { claim: spy.claim } });
    await onlineClaudeSession(ctx);
    await claudeSessions(ctx, 1);
    fake.inject(broadcastTopic("demo"), "backlog");
    await runner.pump();
    assert.equal(spy.calls.length, 2);
    assert.equal(spy.calls[0].poll, spy.calls[1].poll, "live and wake claims share the tick's memo");
    const lanes = new Set([...spy.calls[0].peek.cursors.keys()].map((k) => k.split("\n")[0]));
    assert.ok(lanes.has("live"), "live lane recorded a peek");
    assert.ok(lanes.has("wake"), "wake lane recorded a peek");
  } finally {
    await fake.close();
  }
});

test("a pump peek of a session that left the registry is dropped", async () => {
  const fake = await startFakeNtfy();
  try {
    const ctx = setup(fake);
    const spy = spyClaim();
    const { runner } = makeRunner(ctx, [], { delivery: { claim: spy.claim } });
    const [label] = await claudeSessions(ctx, 1);
    fake.inject(broadcastTopic("demo"), "backlog");
    await runner.pump();
    const cursors = spy.calls[0].peek.cursors;
    assert.ok([...cursors.keys()].some((k) => k.includes(label)), "a peek was recorded for the session");
    rmSync(join(ctx.cfg.stateDir, ctx.cfg.project, "registry", `claude#${label}.json`));
    await runner.pump();
    assert.ok(![...cursors.keys()].some((k) => k.includes(label)), "the peek of the departed session is gone");
  } finally {
    await fake.close();
  }
});
