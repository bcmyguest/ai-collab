// Compaction phases from each harness's source, normalised to one model; no harness or CLI runs.
import { EventType } from "@ag-ui/core";
import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeAdapter } from "../runner/adapters/claude.mjs";
import { activityFor } from "../runner/publish.mjs";
import { compactionFields } from "../lib/compaction.mjs";
import { envelopeToEvent, eventToEnvelope } from "../lib/agui.mjs";

const step = (stepName, metadata) => ({ type: EventType.STEP_FINISHED, stepName, ...(metadata ? { metadata: { aiCollab: { compaction: metadata } } } : {}) });

test("compactionFields keeps known phases and counts, drops anything the harness did not report", () => {
  assert.deepEqual(compactionFields({ trigger: "auto", phase: "started" }), { trigger: "auto", phase: "started" });
  assert.deepEqual(compactionFields({ trigger: "reason-x", phase: "finished", tokensBefore: 182000, tokensAfter: 31000 }),
    { phase: "finished", tokensBefore: 182000, tokensAfter: 31000 });
  assert.deepEqual(compactionFields({ trigger: "manual", phase: "failed", tokensBefore: -1, tokensAfter: 1.5 }), { trigger: "manual", phase: "failed" });
  assert.equal(compactionFields({ trigger: "auto", phase: "done" }), null);
});

test("a finished compaction step publishes a compact row with its compaction fields", () => {
  assert.deepEqual(activityFor(step("compact", { trigger: "auto", phase: "finished", tokensBefore: 182000, tokensAfter: 31000 })),
    [{ type: "compact", input: "compacted · auto", compaction: { trigger: "auto", phase: "finished", tokensBefore: 182000, tokensAfter: 31000 } }]);
  assert.deepEqual(activityFor(step("compact", { phase: "failed" })), [{ type: "compact", input: "compaction failed", compaction: { phase: "failed" } }]);
});

test("a started step keeps its compacting text and gains the compaction field", () => {
  assert.deepEqual(activityFor({ type: EventType.STEP_STARTED, stepName: "compact", metadata: { aiCollab: { compaction: { trigger: "manual", phase: "started" } } } }),
    [{ type: "compact", input: "compacting", compaction: { trigger: "manual", phase: "started" } }]);
});

test("a compact row round-trips through AG-UI with its compaction fields", () => {
  const row = { type: "compact", input: "compacted · auto", compaction: { trigger: "auto", phase: "finished", tokensBefore: 9, tokensAfter: 3 } };
  const envelope = { v: 1, kind: "activity", from: "claude", session: "a", ts: "2026-11-22T10:00:00.000Z", ...row };
  const event = envelopeToEvent(envelope, { id: "ntfy-1" });
  assert.equal(event.type, EventType.STEP_FINISHED);
  assert.equal(event.stepName, "compact");
  assert.deepEqual(eventToEnvelope(JSON.stringify(event)), envelope);
});

test("Claude's compact_boundary becomes one finished step with the SDK token counts", async () => {
  const out = [];
  let stream = null;
  const sdkQuery = () => {
    const items = [];
    let wake = null;
    stream = { push(m) { items.push(m); wake?.(); wake = null; } };
    const q = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (items.length) { yield items.shift(); continue; }
          await new Promise((resolve) => { wake = resolve; });
        }
      },
      async initializationResult() { return { models: [], commands: [] }; },
      async interrupt() {}, async setPermissionMode() {}, async getContextUsage() { return { totalTokens: 0, maxTokens: 1 }; },
      close() {},
    };
    return q;
  };
  const adapter = createClaudeAdapter({ query: sdkQuery });
  const ctx = { emit: (e) => out.push(e), log: () => {}, signal: new AbortController().signal };
  await adapter.open({ project: "demo", cwd: "/tmp/demo", permissionMode: "auto", permission: { permissionMode: "auto" }, place: "folder", env: { PATH: "/usr/bin" } }, ctx);
  stream.push({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 182000, post_tokens: 31000 } });
  for (let i = 0; i < 200 && !out.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(out.map(e => [e.type, e.stepName, e.metadata]), [[EventType.STEP_FINISHED, "compact",
    { aiCollab: { compaction: { trigger: "auto", phase: "finished", tokensBefore: 182000, tokensAfter: 31000 } } }]]);
  await adapter.shutdown?.();
});

test("SessionStart keeps its start row for every source", async () => {
  const { activityEvents } = await import("../lib/activity.mjs");
  assert.deepEqual(activityEvents("claude", "sessionstart", { source: "compact" }), [{ type: "start", input: "session started · compact" }]);
  assert.deepEqual(activityEvents("claude", "sessionstart", { source: "clear" }), [{ type: "start", input: "session started · clear" }]);
});

test("PostCompact is a finished compact row with the trigger", async () => {
  const { activityEvents } = await import("../lib/activity.mjs");
  assert.deepEqual(activityEvents("claude", "postcompact", { trigger: "auto", compact_summary: "s" }),
    [{ type: "compact", input: "compacted · auto", compaction: { trigger: "auto", phase: "finished" } }]);
});

test("compactionFields keeps filesDropped as a count", () => {
  assert.deepEqual(compactionFields({ phase: "started", filesDropped: 4 }), { phase: "started", filesDropped: 4 });
  assert.deepEqual(compactionFields({ phase: "started", filesDropped: -2 }), { phase: "started" });
});

test("a compact row's compaction fields reach the published envelope", async () => {
  const { buildActivity } = await import("../lib/activity.mjs");
  const cfg = { peer: "claude", session: "abc123", wire: "legacy" };
  const { message } = buildActivity(cfg, "claude", { type: "compact", input: "compacted · auto", compaction: { trigger: "auto", phase: "finished", tokensBefore: 182000, tokensAfter: 31000, junk: 1 } }, "2026-11-22T10:00:00.000Z");
  assert.deepEqual(JSON.parse(message).compaction, { trigger: "auto", phase: "finished", tokensBefore: 182000, tokensAfter: 31000 });
});
