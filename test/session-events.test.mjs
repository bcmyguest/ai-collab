// Clear and model switch: one model per event, from hooks, the activity envelope and AG-UI, with a per-agent history for the map.
import test from "node:test";
import assert from "node:assert/strict";
import { EventType } from "@ag-ui/core";
import { activityEvents, buildActivity } from "../lib/activity.mjs";
import { clearFields, modelFields, sessionHistory } from "../lib/session-events.mjs";
import { activityFor } from "../runner/publish.mjs";
import { envelopeToEvent, eventToEnvelope, parseWireEnvelope } from "../lib/agui.mjs";
import { clearText, modelText } from "../web/lib/compaction-view.js";

test("clearFields keeps the count it has and always reports 0 after", () => {
  assert.deepEqual(clearFields({ tokensBefore: 140000 }), { tokensBefore: 140000, tokensAfter: 0 });
  assert.deepEqual(clearFields({ tokensBefore: -4 }), { tokensAfter: 0 });
});

test("modelFields needs both names", () => {
  assert.deepEqual(modelFields({ from: "claude-haiku-5-5", to: " claude-opus-5-5 " }), { from: "claude-haiku-5-5", to: "claude-opus-5-5" });
  assert.equal(modelFields({ from: "claude-haiku-5-5" }), null);
  assert.equal(modelFields({ from: "a", to: "x".repeat(200) }), null);
});

test("Claude's PostModelSwitch becomes a model row with the resolved ids", () => {
  assert.deepEqual(activityEvents("claude", "postmodelswitch", { from_model: "claude-haiku-5-5", to_model: "claude-opus-5-5", requested_model: "opus" }),
    [{ type: "model", input: "Model claude-haiku-5-5 → claude-opus-5-5", modelSwitch: { from: "claude-haiku-5-5", to: "claude-opus-5-5" } }]);
});

test("a model row reaches the published envelope and round-trips through AG-UI", () => {
  const row = { type: "model", input: "Model a → b", modelSwitch: { from: "a", to: "b" } };
  const { message } = buildActivity({ peer: "claude", session: "abc123", wire: "legacy" }, "claude", row, "2026-11-22T10:00:00.000Z");
  assert.deepEqual(parseWireEnvelope(message).modelSwitch, { from: "a", to: "b" });
  const envelope = { v: 1, kind: "activity", from: "claude", session: "abc123", ts: 1000, ...row };
  const event = envelopeToEvent(envelope, { id: "ntfy-1" });
  assert.equal(event.type, EventType.STEP_FINISHED);
  assert.equal(event.stepName, "model");
  assert.deepEqual(eventToEnvelope(JSON.stringify(event)), envelope);
});

test("a runner model step publishes a model row", () => {
  assert.deepEqual(activityFor({ type: EventType.STEP_FINISHED, stepName: "model", metadata: { aiCollab: { modelSwitch: { from: "a", to: "b" } } } }),
    [{ type: "model", input: "Model a → b", modelSwitch: { from: "a", to: "b" } }]);
});

test("the session history keeps compactions, clears and model switches in time order per agent", () => {
  const items = [
    { id: "n1", agent: "claude#a", time: 10, type: "compact", compaction: { phase: "finished", tokensBefore: 182000, tokensAfter: 31000 } },
    { id: "n2", agent: "claude#a", time: 20, type: "clear", clear: { tokensBefore: 140000, tokensAfter: 0 } },
    { id: "n3", agent: "codex#b", time: 30, type: "model", modelSwitch: { from: "x", to: "y" } },
    { id: "n4", agent: "claude#a", time: 40, type: "text", output: "ignored" },
  ];
  const history = sessionHistory(items, 5);
  assert.deepEqual(history.get("claude#a"), [
    { id: "n1", at: 10000, kind: "compaction", phase: "finished", tokensBefore: 182000, tokensAfter: 31000 },
    { id: "n2", at: 20000, kind: "clear", tokensBefore: 140000, tokensAfter: 0 },
  ]);
  assert.deepEqual(history.get("codex#b"), [{ id: "n3", at: 30000, kind: "model", from: "x", to: "y" }]);
});

test("timeline text for clears and model switches", () => {
  assert.equal(clearText({ tokensBefore: 140000, tokensAfter: 0 }), "Cleared · 140k → 0");
  assert.equal(clearText({ tokensAfter: 0 }), "Cleared");
  assert.equal(modelText({ from: "claude-haiku-5-5", to: "claude-opus-5-5" }), "Model claude-haiku-5-5 → claude-opus-5-5");
});

test("a started and finished compaction take one history slot; a subagent's compaction is not the parent's", () => {
  const items = [
    { id: "s", agent: "claude#a", time: 10, type: "compact", compaction: { phase: "started", tokensBefore: 90000, filesDropped: 2 } },
    { id: "f", agent: "claude#a", time: 11, type: "compact", compaction: { phase: "finished", tokensAfter: 20000 } },
    { id: "r", agent: "claude#a", time: 12, subagent: { id: "run-1" }, type: "compact", compaction: { phase: "finished" } },
  ];
  assert.deepEqual(sessionHistory(items, 1).get("claude#a"), [
    { id: "f", at: 11000, kind: "compaction", phase: "finished", tokensBefore: 90000, tokensAfter: 20000, filesDropped: 2 },
  ]);
  assert.equal(sessionHistory(items, 5).get("claude#a").length, 1);
});
