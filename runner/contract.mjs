// Constants and validators of the owned-session contract (docs/owned-sessions-contract.md, runner/types.d.ts).
import { EventType } from "@ag-ui/core";
import { EventSchema } from "@ag-ui/core/schemas";

export const HARNESSES = ["claude", "codex", "cursor", "opencode"];
export const PERMISSION_MODES = ["supervised", "accept-edits", "auto", "full-access"];
export const PLACES = ["folder", "worktree", "openshell"];
export const EVENT_TYPES = [
  EventType.RUN_STARTED, EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_CHUNK, EventType.TOOL_CALL_CHUNK,
  EventType.TOOL_CALL_RESULT, EventType.STEP_STARTED, EventType.STEP_FINISHED, EventType.STATE_DELTA,
  EventType.CUSTOM, EventType.RUN_FINISHED, EventType.RUN_ERROR,
];
export const APPROVAL_REQUESTED = "ai-collab.approval-requested";
export const APPROVAL_RESOLVED = "ai-collab.approval-resolved";
export const NOTICE = "ai-collab.notice";
export const ERROR = "ai-collab.error";
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

export const DEFAULT_PERMISSION = { claude: "auto", codex: "auto", cursor: "supervised", opencode: "supervised" };
export const OPENSHELL_PERMISSION = "full-access";
export const APPROVAL_TIMEOUT_MIN = 30;
const APPROVAL_TIMEOUT_MAX_MIN = 12 * 60;

/** The mode a session starts in when the caller names none: full-access in OpenShell, else the harness default. */
export const defaultPermission = (harness, place = "folder") => (place === "openshell" ? OPENSHELL_PERMISSION : DEFAULT_PERMISSION[harness]);

/** Milliseconds an owned approval waits before the runner denies it: AI_COLLAB_APPROVAL_TIMEOUT_MIN (default 30, at most 12 h, the ntfy cache window). */
export function approvalTimeoutMs(env = process.env) {
  const minutes = Number(env.AI_COLLAB_APPROVAL_TIMEOUT_MIN);
  return (Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, APPROVAL_TIMEOUT_MAX_MIN) : APPROVAL_TIMEOUT_MIN) * 60_000;
}

/** The settings a harness gets for a mode, or an error string when the pair is not allowed. */
export function permissionSettings(harness, mode, place = "folder") {
  const settings = PERMISSION_TABLE[harness]?.[mode];
  if (!settings) return { error: `${harness} has no permission mode ${mode}` };
  if (settings.requiresPlace && settings.requiresPlace !== place) return { error: `${harness} ${mode} runs only in ${settings.requiresPlace}` };
  return { settings };
}

const isText = (value) => typeof value === "string" && value.length > 0;

/** Null for a supported AG-UI event with the fields the runner uses. */
export function eventProblem(e) {
  if (!e || typeof e !== "object" || !EVENT_TYPES.includes(e.type)) return "unknown event type";
  if (!EventSchema.safeParse(e).success) return "invalid AG-UI event";
  if (e.subagentRunId !== undefined && !isText(e.subagentRunId)) return "bad subagent run ID";
  const meta = e.metadata?.aiCollab;
  switch (e.type) {
    case EventType.RUN_STARTED:
      return isText(e.threadId) && isText(e.runId) ? null : "threadId and runId required";
    case EventType.RUN_FINISHED:
      return isText(e.threadId) && isText(e.runId) && [undefined, "success", "cancelled"].includes(e.outcome?.type)
        ? null : "invalid run finish";
    case EventType.RUN_ERROR:
      return isText(meta?.runId) && isText(e.message) ? null : "runId and message required";
    case EventType.TEXT_MESSAGE_CONTENT:
    case EventType.TEXT_MESSAGE_CHUNK:
      return isText(e.messageId) && typeof e.delta === "string" ? null : "messageId and delta required";
    case EventType.TOOL_CALL_CHUNK:
      return isText(e.toolCallId) && isText(e.toolCallName) ? null : "toolCallId and toolCallName required";
    case EventType.TOOL_CALL_RESULT:
      return isText(e.toolCallId) && isText(e.messageId) ? null : "toolCallId and messageId required";
    case EventType.STEP_STARTED:
    case EventType.STEP_FINISHED:
      return isText(e.stepName) ? null : "stepName required";
    case EventType.STATE_DELTA:
      return e.delta.length && e.delta.every(op => ["add", "replace", "remove"].includes(op.op) && STATE_PATHS.includes(op.path))
        ? null : "delta must patch known paths";
    case EventType.CUSTOM:
      return customProblem(e);
  }
}

function customProblem({ name, value }) {
  if (name === NOTICE || name === ERROR) return isText(value) ? null : "event text required";
  if (name === APPROVAL_REQUESTED) {
    return isText(value?.interruptId) && ["tool_approval", "question"].includes(value.reason) &&
      isText(value.toolCallName) && typeof value.summary === "string" ? null : "invalid approval request";
  }
  if (name === APPROVAL_RESOLVED) {
    return isText(value?.interruptId) && ["resolved", "cancelled"].includes(value.status) && RESOLVE_REASONS.includes(value.reason)
      ? null : "invalid approval resolution";
  }
  return "unknown custom event";
}
