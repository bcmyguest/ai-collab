// Maps normalized RunnerEvents onto the existing ntfy envelopes: activity, status, approval, approval-end, receipt, alert.
import { NTFY_MESSAGE_MAX_BYTES, broadcastTopic } from "../lib/config.mjs";
import { publish } from "../lib/ntfy.mjs";
import { publishStatus } from "../lib/inbox.mjs";
import { publishActivity } from "../lib/activity.mjs";
import { approvalMessage, cleanQuestions } from "../lib/approvals.mjs";
import { sendReceipts } from "../lib/receipts.mjs";
import { reportContext } from "../lib/usage.mjs";
import { APPROVAL_TIMEOUT_MIN } from "./contract.mjs";

// A card's expiresAt is when the runner denies it (AI_COLLAB_APPROVAL_TIMEOUT_MIN); this is the default wait.
const DEFAULT_APPROVAL_MS = APPROVAL_TIMEOUT_MIN * 60_000;
const PUBLISH_TIMEOUT_MS = 3000;

const withAgent = (row, e) => (e.subagentRunId ? { ...row, agent: { id: e.subagentRunId, type: e.subagentType || "" } } : row);

/** Activity rows (lib/activity.mjs event shape) for one RunnerEvent; [] when the event has no row on ntfy. */
export function activityFor(e) {
  switch (e.type) {
    case "RUN_STARTED": return e.prompt ? [{ type: "prompt", input: e.prompt }] : [];
    case "TEXT_MESSAGE_END": return e.text ? [withAgent({ type: "text", output: e.text, callId: e.messageId }, e)] : [];
    case "TOOL_CALL_START": return [withAgent({ type: "tool_call", tool: e.toolCallName, input: e.args, callId: e.toolCallId }, e)];
    case "TOOL_CALL_RESULT": return [withAgent({ type: e.ok ? "tool_result" : "error", tool: e.toolCallName, output: e.content ?? "", callId: e.toolCallId }, e)];
    case "STEP_STARTED": return e.stepName === "compact" ? [{ type: "compact", input: ["compacting", e.note].filter(Boolean).join(" · ") }] : [];
    case "CUSTOM": return e.name === "error" ? [{ type: "error", output: e.value }] : [{ type: "text", tool: "Notification", output: e.value }];
    case "RUN_FINISHED": return [{ type: "stop", input: ["turn ended", e.outcome === "cancelled" ? "interrupted" : "", e.reason].filter(Boolean).join(" · ") }];
    case "RUN_ERROR": return [{ type: "error", output: e.message }, { type: "stop", input: "turn ended · failed" }];
    default: return [];
  }
}

/** One activity row when the session ends. */
export const sessionEndedRow = (reason) => ({ type: "stop", input: ["session ended", reason].filter(Boolean).join(" · ") });

/** The approval envelope of an owned session (lib/approvals.mjs shape plus owned:true), or null when it cannot fit. */
export function ownedApprovalMessage(cfg, harness, { id, tool, summary, questions }, { now = Date.now(), ttlMs = DEFAULT_APPROVAL_MS } = {}) {
  const clean = questions === undefined ? undefined : cleanQuestions(questions);
  const req = { tool: String(tool).slice(0, 128), summary: String(summary).slice(0, 300), ...(clean ? { questions: clean } : {}) };
  const message = approvalMessage(cfg, harness, req, { id, expiresAt: now + ttlMs, ts: new Date(now).toISOString() });
  if (!message) return null;
  const owned = JSON.stringify({ ...JSON.parse(message), owned: true });
  return Buffer.byteLength(owned) <= NTFY_MESSAGE_MAX_BYTES ? owned : null;
}

export function approvalEndMessage(cfg, id, reason) {
  return JSON.stringify({ v: 1, kind: "approval-end", from: cfg.peer, session: cfg.session, id, reason, owned: true, ts: new Date().toISOString() });
}

/** Publishes the owned approval card on the broadcast topic; throws when it cannot fit or publish. */
export async function publishApproval(cfg, harness, card, ttlMs) {
  const message = ownedApprovalMessage(cfg, harness, card, { ttlMs });
  if (!message) throw new Error("approval does not fit in one ntfy message");
  const who = `${cfg.peer}#${cfg.session}`;
  await publish(cfg, broadcastTopic(cfg.project), message, { title: `${card.tool} needs approval for ${who}: ${card.summary}`.slice(0, 200), signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS) });
}

export async function publishApprovalEnd(cfg, id, reason) {
  await publish(cfg, broadcastTopic(cfg.project), approvalEndMessage(cfg, id, reason), { signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS) });
}

/** Activity, status and alert publishes for one event; interrupts go through publishApproval. Never throws. */
export async function publishEvent(cfg, harness, e) {
  try {
    const rows = activityFor(e);
    if (rows.length) await publishActivity(cfg, harness, rows, { timeoutMs: PUBLISH_TIMEOUT_MS });
    if (e.type === "RUN_STARTED") await publishStatus(cfg, { event: "start", harness });
    if (e.type === "RUN_FINISHED" || e.type === "RUN_ERROR") await publishStatus(cfg, { event: "stop", harness });
    const tokens = e.type === "STATE_DELTA" ? e.delta.find((op) => op.path === "/contextTokens")?.value : undefined;
    if (Number.isSafeInteger(tokens)) await reportContext(cfg, tokens);
  } catch { /* best effort, like hooks */ }
}

/** Publishes the session-ended row and a stop status. Never throws. */
export async function publishEnded(cfg, harness, reason) {
  try {
    await publishActivity(cfg, harness, [sessionEndedRow(reason)], { timeoutMs: PUBLISH_TIMEOUT_MS });
    await publishStatus(cfg, { event: "stop", harness });
  } catch { /* best effort */ }
}

/** Publishes read receipts for message ids the harness accepted. */
export function publishReceipts(cfg, ids) {
  if (ids?.length) sendReceipts(cfg, ids);
}
