import assert from "node:assert/strict";
import { test } from "node:test";
import { EventType } from "@ag-ui/core";
import { buildEvent, envelopeToEvent, eventToEnvelope, parseEvent, parseWireEnvelope } from "../lib/agui.ts";

const SESSION = "aabbccddeeff0011";
const TS = "2026-11-21T16:20:00.000Z";
const ACTIVITY = { v: 1, kind: "activity", from: "claude", session: SESSION, harness: "claude", ts: TS };

test("builds and validates the official AG-UI lifecycle fields", () => {
  const start = { type: EventType.RUN_STARTED, threadId: `claude#${SESSION}`, runId: "run-2", parentRunId: "run-1" };
  assert.deepEqual(buildEvent(start.type, start), start);
  assert.deepEqual(parseEvent(JSON.stringify(start)), start);
  assert.throws(() => buildEvent(start.type, { runId: "run-2" }), /threadId/);
  assert.equal(parseEvent({ ...start, runId: 42 }), null);
  assert.equal(parseEvent({ type: EventType.TOOL_CALL_RESULT, toolCallId: "call-1" }), null);
  assert.equal(parseEvent("{broken"), null);
});

test("legacy activity round-trips through standard events when it has correlation fields", () => {
  const examples = [
    [EventType.TEXT_MESSAGE_CHUNK, { type: "text", callId: "message-1", output: "hello" }, { messageId: "message-1", delta: "hello", role: "assistant" }],
    [EventType.TOOL_CALL_CHUNK, { type: "tool_call", callId: "call-1", tool: "Bash", input: "ls" }, { toolCallId: "call-1", toolCallName: "Bash", delta: "ls" }],
    [EventType.TOOL_CALL_CHUNK, { type: "tool_call", callId: "call-2", tool: "Bash" }, { toolCallId: "call-2", toolCallName: "Bash" }],
    [EventType.TOOL_CALL_RESULT, { type: "error", callId: "call-1", tool: "Bash", input: "ls", output: "failed" }, { toolCallId: "call-1", messageId: "ntfy-1", content: "failed" }],
    [EventType.STEP_STARTED, { type: "compact", input: "compacting · auto" }, { stepName: "compact" }],
  ];
  for (const [type, row, fields] of examples) {
    const envelope = { ...ACTIVITY, ...row, agent: { id: "child-1", type: "Explore" } };
    const event = envelopeToEvent(envelope, { id: "ntfy-1" });
    assert.equal(event.type, type);
    assert.equal(event.timestamp, Date.parse(TS));
    assert.equal(event.subagentRunId, "child-1");
    for (const [key, value] of Object.entries(fields)) assert.equal(event[key], value);
    assert.deepEqual(eventToEnvelope(JSON.stringify(event)), envelope);
  }
});

test("historical observations without correlation IDs stay identifiable as activity", () => {
  for (const row of [{ type: "prompt", input: "start" }, { type: "stop", input: "turn ended" }, { type: "text", output: "done" }]) {
    const envelope = { ...ACTIVITY, ...row };
    const event = envelopeToEvent(JSON.stringify(envelope));
    assert.equal(event.type, EventType.CUSTOM);
    assert.equal(event.name, "ai-collab.activity");
    assert.deepEqual(parseWireEnvelope(JSON.stringify(event)), envelope);
  }
});

test("chat, receipts, approvals, mode, status and alerts retain AI Collab fields", () => {
  const examples = [
    ["msg", { to: "operator", operatorThread: true, replyTo: "previous", body: "done" }],
    ["receipt", { ids: ["previous"], state: "read" }],
    ["approval", { id: "abc123", questions: [{ question: "Proceed?", options: ["Yes", "No"] }], expiresAt: Date.parse(TS) + 1000 }],
    ["approval-view", { id: "abc123", mode: "terminal" }],
    ["approval-end", { id: "abc123", reason: "answered" }],
    ["mode", { from: "operator", mode: "on", ts: Date.parse(TS) }],
    ["status", { event: "start", parent: "codex#1200000000000000" }],
    ["alert", { contextTokens: 200_000, threshold: 200_000 }],
  ];
  for (const [kind, fields] of examples) {
    const envelope = { v: 1, kind, from: "claude", session: SESSION, ts: TS, ...fields };
    const event = envelopeToEvent(envelope);
    assert.equal(event.type, EventType.CUSTOM);
    assert.equal(event.name, `ai-collab.${kind}`);
    assert.equal(event.timestamp, Date.parse(TS));
    assert.equal(Object.hasOwn(event.value, "v"), false);
    assert.deepEqual(parseWireEnvelope(JSON.stringify(event)), envelope);
    assert.deepEqual(parseWireEnvelope(JSON.stringify(envelope)), envelope);
  }
});

test("dual reads skip malformed, foreign and unprojectable records", () => {
  assert.equal(parseWireEnvelope("reply abc123 yes"), null);
  assert.equal(envelopeToEvent({ v: 2, kind: "msg" }), null);
  assert.equal(parseWireEnvelope({ type: EventType.CUSTOM, name: "foreign.msg", value: { body: "hi" } }), null);
  assert.equal(parseWireEnvelope({ type: EventType.CUSTOM, name: "ai-collab.msg", value: [] }), null);
  assert.equal(parseWireEnvelope({ type: EventType.STATE_SNAPSHOT, snapshot: {} }), null);
  assert.equal(parseWireEnvelope({ type: EventType.TEXT_MESSAGE_CHUNK, delta: "hi" }), null);
});
