// Regression guard for the pump claim window: after a restart with more than 100 newer delivery rows, a message with no
// workflow yet is claimed within a bounded number of pump ticks, not starved behind rows that already have one.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import fc from "fast-check";
import { sessionLabel } from "../lib/config.mjs";
import { sendMessage } from "../lib/inbox.mjs";
import { recordSession } from "../lib/sessions.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { makeRunner, procStart, setup } from "./helpers/runner-ctx.mjs";

// Sized so one read of the inbox (256 KB poll cap) reaches only about 70 of the messages.
const BODY = "x".repeat(3000);
const TICK_LIMIT = 60;
const NUM_RUNS = Number(process.env.FC_RUNS ?? 4);
const SEED = process.env.FC_SEED ? { seed: Number(process.env.FC_SEED) } : {};
// The delivery deps the pump runs with: pushes succeed at once, so a claimed message finishes its push.
const DELIVERY = {
  push: async () => ({ status: "delivered" }),
  ready: async () => true,
  busy: async () => false,
  acked: async () => false,
};

// A claude session whose process is this test process, so the pump sees it online.
async function onlineClaude(ctx) {
  const id = randomUUID();
  await recordSession({ ...ctx.cfg, peer: "claude", session: sessionLabel(id) }, { id, cwd: ctx.root, harness: "claude", event: "stop", proc: { pid: process.pid, start: procStart(process.pid) } });
  return `claude#${sessionLabel(id)}`;
}

const workflowOf = (session, messageId) => `delivery:${session}:${messageId}`;

// Pumps until every listed message has a workflow; fails past TICK_LIMIT, naming how many are still unclaimed.
async function pumpUntilClaimed(runner, durable, session, ids, what) {
  for (let tick = 1; ; tick += 1) {
    const missing = ids.filter((id) => !durable.status(workflowOf(session, id)));
    if (missing.length === 0) return tick - 1;
    assert.ok(tick <= TICK_LIMIT, `${missing.length} ${what} unclaimed after ${TICK_LIMIT} pump ticks`);
    await runner.pump();
  }
}

async function restartGuard(olderCount, newerCount) {
  const fake = await startFakeNtfy();
  try {
    const ctx = setup(fake);
    const session = await onlineClaude(ctx);
    const older = [];
    for (let i = 0; i < olderCount; i += 1) older.push((await sendMessage(ctx.cfg, session, BODY)).id);
    const first = makeRunner(ctx, [], { delivery: DELIVERY });
    await pumpUntilClaimed(first.runner, first.durable, session, older, "older messages");
    await first.durable.close();

    // Newer messages arrive after the older ones have workflows; a restart leaves them with none.
    const newer = [];
    for (let i = 0; i < newerCount; i += 1) newer.push((await sendMessage(ctx.cfg, session, BODY)).id);
    const second = makeRunner(ctx, [], { delivery: DELIVERY });
    try {
      await pumpUntilClaimed(second.runner, second.durable, session, newer, "newer messages after a restart");
    } finally {
      await second.durable.close();
    }
  } finally {
    await fake.close();
  }
}

test("after a restart, messages with no workflow are claimed behind more than 100 started rows", { timeout: 120_000 }, async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 101, max: 115 }),
    fc.integer({ min: 1, max: 6 }),
    (olderCount, newerCount) => restartGuard(olderCount, newerCount),
  ), { numRuns: NUM_RUNS, ...SEED });
});
