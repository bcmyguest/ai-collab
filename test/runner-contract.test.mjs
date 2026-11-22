import { EventType } from "@ag-ui/core";
import test from "node:test";
import assert from "node:assert/strict";
import { APPROVAL_REQUESTED, APPROVAL_RESOLVED, NOTICE, EVENT_TYPES, PERMISSION_TABLE, DEFAULT_PERMISSION, HARNESSES, approvalTimeoutMs, defaultPermission, eventProblem, permissionSettings } from "../runner/contract.mjs";
import { activityFor, ownedApprovalMessage } from "../runner/publish.mjs";

test("every harness has a default permission mode present in its table", () => {
  for (const harness of HARNESSES) assert.ok(PERMISSION_TABLE[harness][DEFAULT_PERMISSION[harness]], harness);
  assert.deepEqual(permissionSettings("claude", "accept-edits").settings, { permissionMode: "acceptEdits" });
  assert.equal(permissionSettings("codex", "auto").settings.approvalsReviewer, "auto_review");
  assert.equal(permissionSettings("opencode", "accept-edits").settings.reply, "once");
  assert.match(permissionSettings("cursor", "full-access", "worktree").error, /openshell/);
  assert.equal(permissionSettings("cursor", "full-access", "openshell").settings.force, true);
  assert.match(permissionSettings("opencode", "auto").error, /no permission mode/);
});

const THREAD = "codex#0123456789abcdef";
const RUN = { threadId: THREAD, runId: "r1" };

function runStarted(prompt) {
  return {
    ...RUN, type: EventType.RUN_STARTED,
    input: { ...RUN, tools: [], context: [], messages: [{ role: "user", id: "m1", content: prompt }] },
  };
}

test("eventProblem accepts each supported AG-UI event and rejects malformed ones", () => {
  const good = [
    runStarted("hi"),
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "he" },
    { type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m", delta: "hello", role: "assistant", subagentRunId: "a1" },
    { type: EventType.TOOL_CALL_CHUNK, toolCallId: "c", toolCallName: "Bash", delta: '{"command":"ls"}' },
    { type: EventType.TOOL_CALL_RESULT, toolCallId: "c", messageId: "r", content: "x" },
    { type: EventType.STEP_STARTED, stepName: "compact" },
    { type: EventType.STEP_FINISHED, stepName: "compact" },
    { type: EventType.STATE_DELTA, delta: [{ op: "replace", path: "/contextTokens", value: 5 }] },
    { type: EventType.CUSTOM, name: NOTICE, value: "hi" },
    { ...RUN, type: EventType.RUN_FINISHED, outcome: { type: "success" } },
    { type: EventType.RUN_ERROR, message: "boom", metadata: { aiCollab: { runId: RUN.runId } } },
  ];
  assert.deepEqual(good.map((e) => e.type), EVENT_TYPES);
  for (const e of good) assert.equal(eventProblem(e), null, e.type);
  assert.equal(eventProblem({
    type: EventType.CUSTOM, name: APPROVAL_REQUESTED,
    value: { interruptId: "i", reason: "tool_approval", toolCallName: "Bash", summary: "ls" },
  }), null);
  assert.equal(eventProblem({
    type: EventType.CUSTOM, name: APPROVAL_RESOLVED,
    value: { interruptId: "i", status: "resolved", reason: "allowed" },
  }), null);
  assert.ok(eventProblem({ type: "turn.started" }));
  assert.ok(eventProblem({ ...RUN, type: EventType.RUN_FINISHED, outcome: { type: "interrupted" } }));
  assert.ok(eventProblem({ type: EventType.STATE_DELTA, delta: [{ op: "replace", path: "/secret", value: 1 }] }));
  assert.ok(eventProblem({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m", delta: "x", subagentRunId: "" }));
});

test("activityFor maps events onto the existing activity row types", () => {
  assert.deepEqual(activityFor(runStarted("go")), [{ type: "prompt", input: "go" }]);
  assert.deepEqual(activityFor({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "x" }), []);
  assert.deepEqual(activityFor({
    type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m", delta: "hi", subagentRunId: "a",
    metadata: { aiCollab: { subagentType: "t" } },
  }), [{ type: "text", output: "hi", callId: "m", agent: { id: "a", type: "t" } }]);
  assert.equal(activityFor({
    type: EventType.TOOL_CALL_RESULT, toolCallId: "c", messageId: "m", content: "no",
    metadata: { aiCollab: { toolCallName: "Bash", failed: true } },
  })[0].type, "error");
  assert.deepEqual(activityFor({
    ...RUN, type: EventType.RUN_FINISHED, outcome: { type: "cancelled" },
    metadata: { aiCollab: { reason: "runner restarted" } },
  }), [{ type: "stop", input: "turn ended · interrupted · runner restarted" }]);
  assert.deepEqual(activityFor({
    type: EventType.RUN_ERROR, message: "boom", metadata: { aiCollab: { runId: RUN.runId } },
  }).map((r) => r.type), ["error", "stop"]);
  assert.deepEqual(activityFor({
    type: EventType.STEP_STARTED, stepName: "compact", metadata: { aiCollab: { note: "auto" } },
  }), [{ type: "compact", input: "compacting · auto" }]);
});

test("an owned approval card is the hook approval envelope plus owned:true", () => {
  const cfg = { peer: "codex", session: "0123456789abcdef" };
  const card = JSON.parse(ownedApprovalMessage(cfg, "codex", { id: "abcdefabcdef", tool: "Bash", summary: "ls" }, { now: 0 }));
  assert.deepEqual(card, {
    v: 1, kind: "approval", from: "codex", session: "0123456789abcdef", harness: "codex", id: "abcdefabcdef", tool: "Bash", summary: "ls",
    expiresAt: 30 * 60 * 1000, ts: new Date(0).toISOString(), owned: true,
  });
});

test("default modes follow the operator decisions; OpenShell defaults every harness to full-access", () => {
  assert.deepEqual(DEFAULT_PERMISSION, { claude: "auto", codex: "auto", cursor: "supervised", opencode: "supervised" });
  for (const harness of HARNESSES) {
    assert.equal(defaultPermission(harness, "worktree"), DEFAULT_PERMISSION[harness]);
    assert.equal(defaultPermission(harness, "openshell"), "full-access");
  }
});

test("the approval timeout is AI_COLLAB_APPROVAL_TIMEOUT_MIN minutes, default 30, at most 12 h", () => {
  assert.equal(approvalTimeoutMs({}), 30 * 60_000);
  assert.equal(approvalTimeoutMs({ AI_COLLAB_APPROVAL_TIMEOUT_MIN: "5" }), 5 * 60_000);
  assert.equal(approvalTimeoutMs({ AI_COLLAB_APPROVAL_TIMEOUT_MIN: "0" }), 30 * 60_000);
  assert.equal(approvalTimeoutMs({ AI_COLLAB_APPROVAL_TIMEOUT_MIN: "x" }), 30 * 60_000);
  assert.equal(approvalTimeoutMs({ AI_COLLAB_APPROVAL_TIMEOUT_MIN: "9999" }), 720 * 60_000);
});
