import test from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES, PERMISSION_TABLE, DEFAULT_PERMISSION, HARNESSES, eventProblem, permissionSettings } from "../runner/contract.mjs";
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

test("eventProblem accepts each AG-UI-named event and rejects malformed ones", () => {
  const good = [
    { type: "RUN_STARTED", runId: "r1", prompt: "hi" },
    { type: "TEXT_MESSAGE_CHUNK", messageId: "m", delta: "he" },
    { type: "TEXT_MESSAGE_END", messageId: "m", text: "hello", subagentRunId: "a1", subagentType: "explore" },
    { type: "TOOL_CALL_START", toolCallId: "c", toolCallName: "Bash", args: { command: "ls" } },
    { type: "TOOL_CALL_RESULT", toolCallId: "c", toolCallName: "Bash", ok: true, content: "x" },
    { type: "INTERRUPT_REQUESTED", interruptId: "i", reason: "tool_approval", toolCallName: "Bash", summary: "ls" },
    { type: "INTERRUPT_RESOLVED", interruptId: "i", status: "resolved", reason: "allowed" },
    { type: "STEP_STARTED", stepName: "compact" },
    { type: "STEP_FINISHED", stepName: "compact" },
    { type: "STATE_DELTA", delta: [{ op: "replace", path: "/contextTokens", value: 5 }] },
    { type: "CUSTOM", name: "notice", value: "hi" },
    { type: "RUN_FINISHED", runId: "r1", outcome: "success" },
    { type: "RUN_ERROR", runId: "r1", message: "boom" },
  ];
  assert.deepEqual(good.map((e) => e.type), EVENT_TYPES);
  for (const e of good) assert.equal(eventProblem(e), null, e.type);
  assert.ok(eventProblem({ type: "turn.started" }));
  assert.ok(eventProblem({ type: "RUN_FINISHED", runId: "r1", outcome: "interrupted" }));
  assert.ok(eventProblem({ type: "STATE_DELTA", delta: [{ op: "replace", path: "/secret", value: 1 }] }));
  assert.ok(eventProblem({ type: "TEXT_MESSAGE_END", messageId: "m", text: "x", subagentRunId: "" }));
});

test("activityFor maps events onto the existing activity row types", () => {
  assert.deepEqual(activityFor({ type: "RUN_STARTED", runId: "r", prompt: "go" }), [{ type: "prompt", input: "go" }]);
  assert.deepEqual(activityFor({ type: "TEXT_MESSAGE_CHUNK", messageId: "m", delta: "x" }), []);
  assert.deepEqual(activityFor({ type: "TEXT_MESSAGE_END", messageId: "m", text: "hi", subagentRunId: "a", subagentType: "t" }), [{ type: "text", output: "hi", callId: "m", agent: { id: "a", type: "t" } }]);
  assert.equal(activityFor({ type: "TOOL_CALL_RESULT", toolCallId: "c", toolCallName: "Bash", ok: false, content: "no" })[0].type, "error");
  assert.deepEqual(activityFor({ type: "RUN_FINISHED", runId: "r", outcome: "cancelled", reason: "runner restarted" }), [{ type: "stop", input: "turn ended · interrupted · runner restarted" }]);
  assert.deepEqual(activityFor({ type: "RUN_ERROR", runId: "r", message: "boom" }).map((r) => r.type), ["error", "stop"]);
  assert.deepEqual(activityFor({ type: "STEP_STARTED", stepName: "compact", note: "auto" }), [{ type: "compact", input: "compacting · auto" }]);
});

test("an owned approval card is the hook approval envelope plus owned:true", () => {
  const cfg = { peer: "codex", session: "0123456789abcdef" };
  const card = JSON.parse(ownedApprovalMessage(cfg, "codex", { id: "abcdefabcdef", tool: "Bash", summary: "ls" }, { now: 0 }));
  assert.deepEqual(card, {
    v: 1, kind: "approval", from: "codex", session: "0123456789abcdef", harness: "codex", id: "abcdefabcdef", tool: "Bash", summary: "ls",
    expiresAt: 12 * 3600 * 1000, ts: new Date(0).toISOString(), owned: true,
  });
});
