// Constants and validators of the owned-session contract (docs/owned-sessions-contract.md, runner/types.d.ts).

export const HARNESSES = ["claude", "codex", "cursor", "opencode"];
export const PERMISSION_MODES = ["supervised", "accept-edits", "auto", "full-access"];
export const PLACES = ["folder", "worktree", "openshell"];
// Named after AG-UI 1.0 event types (@ag-ui/core EventType) so a later AG-UI stream maps them one to one.
export const EVENT_TYPES = [
  "RUN_STARTED", "TEXT_MESSAGE_CHUNK", "TEXT_MESSAGE_END", "TOOL_CALL_START", "TOOL_CALL_RESULT",
  "INTERRUPT_REQUESTED", "INTERRUPT_RESOLVED", "STEP_STARTED", "STEP_FINISHED", "STATE_DELTA", "CUSTOM",
  "RUN_FINISHED", "RUN_ERROR",
];
export const RESOLVE_REASONS = ["allowed", "denied", "answered", "cancelled"];
export const STATE_PATHS = ["/contextTokens", "/contextWindow", "/model", "/permissionMode"];

// Codex values follow T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.), CodexAdapterV2.ts L751-L800 at 5935157.
export const PERMISSION_TABLE = {
  claude: {
    supervised: { permissionMode: "default" },
    "accept-edits": { permissionMode: "acceptEdits" },
    auto: { permissionMode: "auto" },
    "full-access": { permissionMode: "bypassPermissions" },
  },
  codex: {
    supervised: { approvalPolicy: "untrusted", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly" } },
    "accept-edits": { approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: { type: "workspaceWrite" } },
    auto: { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandboxPolicy: { type: "workspaceWrite" } },
    "full-access": {
      approvalPolicy: { granular: { mcp_elicitations: true, request_permissions: false, rules: false, sandbox_approval: false, skill_approval: false } },
      approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" },
    },
  },
  opencode: {
    supervised: { autoReply: [], reply: "once" },
    "accept-edits": { autoReply: ["edit"], reply: "once" },
    "full-access": { autoReply: ["*"], reply: "once" },
  },
  cursor: {
    supervised: { force: false },
    "full-access": { force: true, requiresPlace: "openshell" },
  },
};

export const DEFAULT_PERMISSION = { claude: "accept-edits", codex: "auto", cursor: "supervised", opencode: "accept-edits" };

/** The settings a harness gets for a mode, or an error string when the pair is not allowed. */
export function permissionSettings(harness, mode, place = "folder") {
  const settings = PERMISSION_TABLE[harness]?.[mode];
  if (!settings) return { error: `${harness} has no permission mode ${mode}` };
  if (settings.requiresPlace && settings.requiresPlace !== place) return { error: `${harness} ${mode} runs only in ${settings.requiresPlace}` };
  return { settings };
}

const isText = (value) => typeof value === "string" && value.length > 0;
const isSub = (e) => (e.subagentRunId === undefined || isText(e.subagentRunId)) && (e.subagentType === undefined || typeof e.subagentType === "string");

/** Null for a well-formed RunnerEvent, else the reason it is rejected. */
export function eventProblem(e) {
  if (!e || typeof e !== "object" || !EVENT_TYPES.includes(e.type)) return "unknown event type";
  if (!isSub(e)) return "bad subagent fields";
  switch (e.type) {
    case "RUN_STARTED": return isText(e.runId) ? null : "runId required";
    case "TEXT_MESSAGE_CHUNK": return isText(e.messageId) && typeof e.delta === "string" ? null : "messageId and delta required";
    case "TEXT_MESSAGE_END": return isText(e.messageId) && typeof e.text === "string" ? null : "messageId and text required";
    case "TOOL_CALL_START": return isText(e.toolCallId) && isText(e.toolCallName) ? null : "toolCallId and toolCallName required";
    case "TOOL_CALL_RESULT": return isText(e.toolCallId) && isText(e.toolCallName) && typeof e.ok === "boolean" ? null : "toolCallId, toolCallName and ok required";
    case "INTERRUPT_REQUESTED": return isText(e.interruptId) && ["tool_approval", "question"].includes(e.reason) && isText(e.toolCallName) && typeof e.summary === "string" ? null : "interruptId, reason, toolCallName and summary required";
    case "INTERRUPT_RESOLVED": return isText(e.interruptId) && ["resolved", "cancelled"].includes(e.status) && RESOLVE_REASONS.includes(e.reason) ? null : "interruptId, status and reason required";
    case "STEP_STARTED": case "STEP_FINISHED": return isText(e.stepName) ? null : "stepName required";
    case "STATE_DELTA": return Array.isArray(e.delta) && e.delta.length && e.delta.every((op) => ["add", "replace", "remove"].includes(op?.op) && STATE_PATHS.includes(op.path)) ? null : "delta must patch known paths";
    case "CUSTOM": return ["notice", "error"].includes(e.name) && isText(e.value) ? null : "name notice|error and value required";
    case "RUN_FINISHED": return isText(e.runId) && ["success", "cancelled"].includes(e.outcome) ? null : "runId and outcome required";
    case "RUN_ERROR": return isText(e.runId) && isText(e.message) ? null : "runId and message required";
    default: return null;
  }
}
