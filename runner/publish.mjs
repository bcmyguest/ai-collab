// Publishes runner activity as AG-UI and sends status, approvals, receipts and alerts on their existing topics.
import { contentToText, EventType } from "@ag-ui/core";
import { broadcastTopic } from "../lib/config.mjs";
import { approvalEnd } from "../lib/operator.ts";
import { publish } from "../lib/messaging.ts";
import { publishStatus } from "../lib/messaging.ts";
import { publishActivity } from "../lib/activity.ts";
import { compactionFields } from "../lib/compaction.ts";
import { modelFields } from "../lib/session-events.mjs";
import { approvalMessage, cleanQuestions } from "../lib/approvals.ts";
import { sendReceipts } from "../lib/receipts.ts";
import { reportContext } from "../lib/usage.ts";
import { APPROVAL_TIMEOUT_MIN, ERROR, NOTICE } from "./contract.mjs";

// A card's expiresAt is when the runner denies it (AI_COLLAB_APPROVAL_TIMEOUT_MIN); this is the default wait.
const DEFAULT_APPROVAL_MS = APPROVAL_TIMEOUT_MIN * 60_000;
const PUBLISH_TIMEOUT_MS = 3000;

const withAgent = (row, e) => (e.subagentRunId ? { ...row, agent: { id: e.subagentRunId, type: e.metadata?.aiCollab?.subagentType || "" } } : row);

// A compact row; a step carrying metadata.aiCollab.compaction also gets the shared compaction fields.
function compactRow(type, meta) {
  const fields = meta?.compaction ? compactionFields(meta.compaction) : null;
  const compaction = fields ? { compaction: fields } : {};
  if (type === EventType.STEP_FINISHED) {
    const input = fields?.phase === "failed" ? "compaction failed" : ["compacted", fields?.trigger].filter(Boolean).join(" · ");
    return { type: "compact", input, ...compaction };
  }
  return { type: "compact", input: ["compacting", meta?.note].filter(Boolean).join(" · "), ...compaction };
}

/** Activity rows (lib/activity.ts event shape) for one RunnerEvent; [] when the event has no row on ntfy. */
export function activityFor(e, { system } = {}) {
  const meta = e.metadata?.aiCollab;
  switch (e.type) {
    case EventType.RUN_STARTED: {
      const prompt = contentToText(e.input?.messages.findLast(message => message.role === "user")?.content);
      return prompt ? [{ type: "prompt", input: prompt, ...(system === true ? { system: true } : {}) }] : [];
    }
    case EventType.TEXT_MESSAGE_CHUNK:
      return e.delta ? [withAgent({ type: "text", output: e.delta, callId: e.messageId }, e)] : [];
    case EventType.TOOL_CALL_CHUNK:
      return [withAgent({ type: "tool_call", tool: e.toolCallName, input: e.delta, callId: e.toolCallId }, e)];
    case EventType.TOOL_CALL_RESULT:
      return [withAgent({
        type: meta?.failed ? "error" : "tool_result", tool: meta?.toolCallName,
        output: contentToText(e.content), callId: e.toolCallId,
      }, e)];
    case EventType.STEP_STARTED:
    case EventType.STEP_FINISHED:
      if (e.stepName === "model") {
        const fields = e.type === EventType.STEP_FINISHED && meta?.modelSwitch ? modelFields(meta.modelSwitch) : null;
        return fields ? [{ type: "model", input: `Model ${fields.from} → ${fields.to}`, modelSwitch: fields }] : [];
      }
      return e.stepName === "compact" ? [compactRow(e.type, meta)] : [];
    case EventType.CUSTOM:
      if (e.name === ERROR) return [{ type: "error", output: e.value }];
      return e.name === NOTICE ? [{ type: "text", tool: "Notification", output: e.value }] : [];
    case EventType.RUN_FINISHED:
      return [{ type: "stop", input: ["turn ended", e.outcome?.type === "cancelled" ? "interrupted" : "", meta?.reason].filter(Boolean).join(" · ") }];
    case EventType.RUN_ERROR:
      return [{ type: "error", output: e.message }, { type: "stop", input: "turn ended · failed" }];
    default: return [];
  }
}

/** One activity row when the session ends. */
export const sessionEndedRow = (reason) => ({ type: "stop", input: ["session ended", reason].filter(Boolean).join(" · ") });

/** The approval envelope of an owned session (lib/approvals.ts shape plus owned:true), or null when it cannot fit. */
export function ownedApprovalMessage(cfg, harness, { id, tool, summary, questions }, { now = Date.now(), ttlMs = DEFAULT_APPROVAL_MS } = {}) {
  const clean = questions === undefined ? undefined : cleanQuestions(questions);
  const req = { tool: String(tool).slice(0, 128), summary: String(summary).slice(0, 300), ...(clean ? { questions: clean } : {}) };
  return approvalMessage(cfg, harness, req, { id, expiresAt: now + ttlMs, ts: new Date(now).toISOString(), owned: true });
}

export function approvalEndMessage(cfg, id, reason) {
  return approvalEnd(cfg, id, reason, { session: cfg.session, owned: true });
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
export async function publishEvent(cfg, harness, e, options) {
  try {
    const rows = activityFor(e, options);
    if (rows.length) await publishActivity(cfg, harness, rows, { timeoutMs: PUBLISH_TIMEOUT_MS, run: e });
    if (e.type === EventType.RUN_STARTED) await publishStatus(cfg, { event: "start", harness });
    if (e.type === EventType.RUN_FINISHED || e.type === EventType.RUN_ERROR) await publishStatus(cfg, { event: "stop", harness });
    const tokens = e.type === EventType.STATE_DELTA ? e.delta.find((op) => op.path === "/contextTokens")?.value : undefined;
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
