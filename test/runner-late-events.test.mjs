// A late adapter event must not reopen an ended session: onEvent drops every event once the owned record is
// "ended", while events emitted while live.close() runs (before the status lands) still apply.
import test from "node:test";
import assert from "node:assert/strict";
import { EventType } from "@ag-ui/core";
import { sessionLabel } from "../lib/config.mjs";
import { readOwned } from "../lib/sessions/registry.ts";
import { openDurable } from "../runner/durable.mjs";
import { createRunner } from "../runner/runner.mjs";
import { createFakeAdapter } from "../runner/adapters/fake.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { setup, until } from "./helpers/runner-ctx.mjs";
import { wrapOpen } from "./helpers/fake-adapter-hooks.mjs";

const runStarted = (threadId, runId, text) => ({
  type: EventType.RUN_STARTED, threadId, runId,
  input: { threadId, runId, tools: [], context: [], messages: [{ id: `${runId}:input`, role: "user", content: text }] },
});
const runFinished = (threadId, runId) => ({ type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: "success" } });
const published = (fake, text) => fake.state.publishes.some((p) => JSON.stringify(p).includes(text));

// A runner over the fake adapter with the open context's emit captured, so the test can emit as the harness.
function makeRunner(ctx, adapter) {
  const logs = [];
  const seen = { emit: null };
  const wrapped = wrapOpen(adapter, async (options, context, open) => {
    seen.emit = context.emit;
    return open(options, context);
  });
  const runner = createRunner({
    projects: [ctx.cfg], adapters: new Map([[wrapped.harness, wrapped]]), durable: openDurable(ctx.db),
    env: ctx.env, startGapMs: 0, watch: false, pumpMs: 0, log: (message) => logs.push(message),
  });
  return { runner, logs, emit: (e) => seen.emit(e) };
}

test("a late RUN_STARTED and RUN_FINISHED after close leave the owned record ended", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const { runner, logs, emit } = makeRunner(ctx, createFakeAdapter({ harness: "codex" }));
  await runner.boot();
  try {
    const { session, nativeId } = await runner.start({ project: "demo", harness: "codex", prompt: "hi" });
    await until(() => runner.get(session).status === "idle", "idle");
    assert.deepEqual(await runner.close(session), { status: "ended" });
    const label = sessionLabel(nativeId);
    const threadId = `codex#${label}`;

    emit(runStarted(threadId, "late-1", "resumed from the dead"));
    emit(runFinished(threadId, "late-1"));

    const record = readOwned(ctx.cfg, label);
    assert.equal(record.status, "ended", "a late run event must not reopen the record");
    assert.equal(record.run, null);
    assert.ok(logs.some((line) => line.includes("dropped event")), "each dropped event logs one line");
  } finally {
    await runner.stop();
    await fake.close();
  }
});

test("an event emitted while live.close() runs still applies", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  let emit = null;
  // The harness still has one event in flight when the runner closes the handle.
  const adapter = wrapOpen(createFakeAdapter({ harness: "codex" }), async (options, context, open) => {
    emit = context.emit;
    const handle = await open(options, context);
    return {
      ...handle,
      close: async () => {
        emit(runStarted(`codex#${sessionLabel(handle.nativeId)}`, "closing-1", "emitted while closing"));
        return handle.close();
      },
    };
  });
  const runner = createRunner({
    projects: [ctx.cfg], adapters: new Map([["codex", adapter]]), durable: openDurable(ctx.db),
    env: ctx.env, startGapMs: 0, watch: false, pumpMs: 0,
  });
  await runner.boot();
  try {
    const { session, nativeId } = await runner.start({ project: "demo", harness: "codex", prompt: "hi" });
    await until(() => runner.get(session).status === "idle", "idle");
    assert.deepEqual(await runner.close(session), { status: "ended" });
    await runner.settle();
    assert.ok(published(fake, "emitted while closing"), "the event emitted during close() was applied");
    assert.equal(readOwned(ctx.cfg, sessionLabel(nativeId)).status, "ended");
  } finally {
    await runner.stop();
    await fake.close();
  }
});
