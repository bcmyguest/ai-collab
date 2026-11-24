import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig } from "../lib/config.mjs";
import { claimInbox, sendMessage } from "../lib/inbox.mjs";
import { decideStop } from "../lib/stop.mjs";
import { askQuestion, openQuestions, requestWait, waitRequestedAt } from "../lib/questions.mjs";

const SESSION = "aabbccddeeff0123";
const ALL = "ai-collab-demo--to--all";

async function setup(t, extra = {}) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "alice", AI_COLLAB_SESSION: SESSION, AI_COLLAB_STOP_POLL_MS: "5000", ...extra });
  const cfg = loadConfig(env);
  const operator = loadConfig(peerEnv(fake, { peer: "operator" }));
  // Injected clock: wait(ms) jumps to the next scheduled event (like a stream wake-up) or to the deadline.
  const clock = { t: Date.now(), slept: 0, waits: 0, events: [] };
  const now = () => clock.t;
  const wait = async (ms) => {
    clock.waits += 1;
    const next = clock.events.sort((a, b) => a.at - b.at)[0];
    const step = next && next.at - clock.t <= ms ? Math.max(0, next.at - clock.t) : ms;
    clock.t += step;
    clock.slept += step;
    if (next && next.at <= clock.t) {
      clock.events.shift();
      await next.run();
    }
  };
  return { fake, cfg, operator, clock, deps: { now, wait } };
}

async function setMode(fake, cfg, mode) {
  fake.inject(ALL, JSON.stringify({ v: 1, kind: "mode", from: "operator", mode, ts: Date.now() }));
  await claimInbox(cfg); // the next hook records it
}

test("off mode: Stop delivers a waiting operator broadcast with reply instructions, else stops at once", async (t) => {
  const { cfg, operator, clock, deps } = await setup(t);
  assert.deepEqual(await decideStop(cfg, { host: "claude", input: { stop_hook_active: false }, ...deps }), { action: "stop" });
  await sendMessage(operator, "all", `@alice#${SESSION} Where are we?`);
  const r = await decideStop(cfg, { host: "claude", input: { stop_hook_active: false }, ...deps });
  assert.equal(r.action, "continue");
  assert.equal(r.why, "messages");
  assert.match(r.text, /body="@alice#aabbccddeeff0123 Where are we\?" This is an operator broadcast\. Answer it in the shared channel with the ai-collab send_to_all tool \(reply_to="m\d+", session="aabbccddeeff0123"/);
  assert.match(r.text, /reply_to_operator tool/, "identity line carries the direct-reply how-to");
  assert.equal(clock.slept, 0, "off mode never waits");
});

test("loop guard: at most stopCap consecutive message continuations, then a forced stop resets the chain", async (t) => {
  const { cfg, operator, deps } = await setup(t, { AI_COLLAB_STOP_CAP: "2" });
  const stop = (active) => decideStop(cfg, { host: "codex", input: { stop_hook_active: active }, ...deps });
  await sendMessage(operator, "all", `@alice#${SESSION} one`);
  assert.equal((await stop(false)).action, "continue");
  await sendMessage(operator, "all", `@alice#${SESSION} two`);
  assert.equal((await stop(true)).action, "continue");
  await sendMessage(operator, "all", `@alice#${SESSION} three`);
  assert.deepEqual(await stop(true), { action: "stop" }, "cap reached: the message stays queued");
  const next = await stop(false);
  assert.equal(next.action, "continue");
  assert.match(next.text, /body="@alice#aabbccddeeff0123 three"/);
});

test("afk on: after wait_for_operator, Stop waits for an operator message and continues when one arrives", async (t) => {
  const { fake, cfg, operator, clock, deps } = await setup(t);
  await setMode(fake, cfg, "on");
  await requestWait(cfg);
  clock.events.push({ at: clock.t + 180_000, run: () => sendMessage(operator, "all", `@alice#${SESSION} Next: run the migration`) });
  const r = await decideStop(cfg, { host: "claude", input: { stop_hook_active: false }, ...deps });
  assert.equal(r.why, "messages");
  assert.match(r.text, /Next: run the migration/);
  assert.equal(clock.slept, 180_000);
});

test("afk on: the wait is bounded by the configured time, then the agent stops", async (t) => {
  const { fake, cfg, clock, deps } = await setup(t, { AI_COLLAB_AFK_WAIT_S: "120" });
  await setMode(fake, cfg, "on");
  await requestWait(cfg);
  assert.deepEqual(await decideStop(cfg, { host: "cursor", input: { status: "completed", loop_count: 0 }, ...deps }), { action: "stop" });
  assert.equal(clock.slept, 120_000);
});

test("afk on: a wait longer than one hook slice continues the turn and resumes the same deadline", async (t) => {
  const { fake, cfg, clock, deps } = await setup(t, { AI_COLLAB_AFK_WAIT_S: "900" });
  await setMode(fake, cfg, "on");
  await requestWait(cfg);
  const first = await decideStop(cfg, { host: "claude", input: { stop_hook_active: false }, ...deps, sliceMaxS: 600 });
  assert.equal(first.why, "afk-wait");
  assert.match(first.text, /End your turn now/);
  assert.equal(clock.slept, 600_000);
  assert.deepEqual(await decideStop(cfg, { host: "claude", input: { stop_hook_active: true }, ...deps, sliceMaxS: 600 }), { action: "stop" });
  assert.equal(clock.slept, 900_000, "the second call waits only the remaining 300 s");
});

test("afk on: a Stop the agent did not ask to wait ends at once", async (t) => {
  const { fake, cfg, clock, deps } = await setup(t);
  await setMode(fake, cfg, "on");
  assert.deepEqual(await decideStop(cfg, { host: "claude", input: { stop_hook_active: false }, ...deps }), { action: "stop" });
  assert.equal(clock.slept, 0);
});

test("afk on: onHold runs once when the Stop waits, and never for a Stop that ends at once", async (t) => {
  const { fake, cfg, deps } = await setup(t, { AI_COLLAB_AFK_WAIT_S: "60" });
  await setMode(fake, cfg, "on");
  let holds = 0;
  const onHold = () => { holds += 1; };
  assert.deepEqual(await decideStop(cfg, { host: "claude", input: { stop_hook_active: false }, ...deps, onHold }), { action: "stop" });
  assert.equal(holds, 0, "no wait was asked for");
  await requestWait(cfg);
  assert.deepEqual(await decideStop(cfg, { host: "claude", input: { stop_hook_active: false }, ...deps, onHold }), { action: "stop" });
  assert.equal(holds, 1);
});

test("afk on: the stop consumes the wait request, so the next Stop ends at once", async (t) => {
  const { fake, cfg, clock, deps } = await setup(t, { AI_COLLAB_AFK_WAIT_S: "60" });
  await setMode(fake, cfg, "on");
  await requestWait(cfg);
  assert.deepEqual(await decideStop(cfg, { host: "claude", input: { stop_hook_active: false }, ...deps }), { action: "stop" });
  assert.equal(clock.slept, 60_000);
  assert.equal(waitRequestedAt(cfg), 0);
  assert.deepEqual(await decideStop(cfg, { host: "claude", input: { stop_hook_active: false }, ...deps }), { action: "stop" });
  assert.equal(clock.slept, 60_000, "no second wait");
});

test("afk on: a plain ask_question arms the wait and its answer continues the agent", async (t) => {
  const { fake, cfg, clock, deps } = await setup(t);
  await setMode(fake, cfg, "on");
  const q = await askQuestion(cfg, "Which colour?", { seconds: 0 });
  clock.events.push({ at: clock.t + 90_000, run: () => fake.inject(ALL, `reply ${q.id} blue`) });
  const r = await decideStop(cfg, { host: "claude", input: { stop_hook_active: false }, ...deps });
  assert.equal(r.why, "answer");
  assert.match(r.text, /answer="blue"/);
  assert.equal(waitRequestedAt(cfg), 0);
});

test("off mode: Stop delivers a board answer once without waiting", async (t) => {
  const { fake, cfg, clock, deps } = await setup(t);
  const q = await askQuestion(cfg, "Which region?", { seconds: 0 });
  fake.inject(ALL, "reply " + q.id + " west");
  const stop = () => decideStop(cfg, { host: "claude", ...deps });
  const result = await stop();
  assert.equal(result.why, "answer");
  assert.match(result.text, /answer="west"/);
  assert.deepEqual(openQuestions(cfg), []);
  assert.equal(waitRequestedAt(cfg), 0);
  assert.deepEqual(await stop(), { action: "stop" });
  assert.equal(clock.waits, 0);
});

test("afk on: an important question holds the session past the AFK wait until it is answered", async (t) => {
  const { fake, cfg, clock, deps } = await setup(t, { AI_COLLAB_AFK_WAIT_S: "60" });
  await setMode(fake, cfg, "on");
  const q = await askQuestion(cfg, "Drop the old table?", { seconds: 0, important: true });
  assert.equal(q.status, "pending");
  assert.deepEqual(openQuestions(cfg).map(({ id, important }) => ({ id, important })), [{ id: q.id, important: true }]);
  assert.match(fake.state.publishes.at(-1).title, /^Important question from alice#/);

  const hold = await decideStop(cfg, { host: "claude", input: { stop_hook_active: false }, ...deps, sliceMaxS: 300 });
  assert.equal(hold.why, "important");
  assert.match(hold.text, new RegExp(`wait_for_answer tool once with id="${q.id}"`));
  assert.equal(clock.slept, 300_000, "holds a full slice, beyond the 60 s AFK wait");

  clock.events.push({ at: clock.t + 50_000, run: () => fake.inject(ALL, `reply ${q.id} yes, drop it`) });
  const answered = await decideStop(cfg, { host: "claude", input: { stop_hook_active: true }, ...deps, sliceMaxS: 300 });
  assert.equal(answered.why, "answer");
  assert.match(answered.text, /answer="yes, drop it"/);
  assert.deepEqual(openQuestions(cfg), []);
});

test("quiet: no idle wait, but an important question still holds; off ignores it", async (t) => {
  const { fake, cfg, clock, deps } = await setup(t);
  await askQuestion(cfg, "Which region?", { seconds: 0, important: true });
  assert.deepEqual(await decideStop(cfg, { host: "codex", input: { stop_hook_active: false }, ...deps }), { action: "stop" });
  assert.equal(clock.slept, 0);
  await setMode(fake, cfg, "quiet");
  const r = await decideStop(cfg, { host: "codex", input: { stop_hook_active: false }, ...deps, sliceMaxS: 30 });
  assert.equal(r.why, "important");
  assert.match(r.text, /AFK mode is QUIET/);
});

test("the real wait holds one streaming subscription and wakes on the first event instead of polling", { timeout: 10000 }, async (t) => {
  const { fake, cfg, operator } = await setup(t, { AI_COLLAB_AFK_WAIT_S: "30" });
  await setMode(fake, cfg, "on");
  await requestWait(cfg);
  const polls = fake.state.polls.length;
  const started = Date.now();
  setTimeout(() => sendMessage(operator, "all", `@alice#${SESSION} wake up`), 300);
  const r = await decideStop(cfg, { host: "claude", input: { stop_hook_active: false } });
  assert.equal(r.why, "messages");
  assert.match(r.text, /wake up/);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  // since=<start second> may replay the already-claimed mode event once; the next stream resumes after its id.
  assert.ok(fake.state.subscribes.length <= 2, `subscribed ${fake.state.subscribes.length} times`);
  // One inbox claim (two topic reads) up front and one per wake-up; none while idle.
  const claims = fake.state.polls.length - polls;
  assert.ok(claims <= 2 + 2 * fake.state.subscribes.length, `polled ${claims} times`);
});

test("a failing stream backs off exponentially instead of hammering ntfy", { timeout: 10000 }, async (t) => {
  const { fake, cfg } = await setup(t, { AI_COLLAB_AFK_WAIT_S: "3", AI_COLLAB_STOP_POLL_MS: "200" });
  await setMode(fake, cfg, "on");
  const before = fake.state.requests;
  fake.state.failNext = 1000;
  assert.deepEqual(await decideStop(cfg, { host: "claude", input: { stop_hook_active: false } }), { action: "stop" });
  // Backoff 200, 400, 800, 1600 ms within 3 s: at most 5 stream attempts, each followed by one claim (2 reads).
  assert.ok(fake.state.requests - before <= 2 + 3 * 5, `${fake.state.requests - before} requests`);
});

test("cursor: an aborted or errored stop never continues", async (t) => {
  const { cfg, operator, deps } = await setup(t);
  await sendMessage(operator, "all", `@alice#${SESSION} hi`);
  assert.deepEqual(await decideStop(cfg, { host: "cursor", input: { status: "aborted" }, ...deps }), { action: "stop" });
  assert.equal((await decideStop(cfg, { host: "cursor", input: { status: "completed" }, ...deps })).action, "continue");
});

test("Skip releases Stop when an important question is pending", async (t) => {
  const { fake, cfg, clock, deps } = await setup(t);
  await setMode(fake, cfg, "on");
  const { id } = await askQuestion(cfg, "Which region?", { seconds: 0, important: true });
  clock.events.push({
    at: clock.t + 5000,
    run: () => fake.inject(ALL, JSON.stringify({ v: 1, kind: "approval-end", from: "operator", id, reason: "skipped" })),
  });
  const stop = () => decideStop(cfg, { host: "claude", ...deps });
  const result = await stop();
  assert.equal(result.action, "continue");
  assert.match(result.text, new RegExp(`operator skipped your question id=${id}`));
  assert.equal(clock.slept, 5000);
  assert.deepEqual(openQuestions(cfg), []);
  assert.equal(waitRequestedAt(cfg), 0);
  assert.deepEqual(await stop(), { action: "stop" });
});
