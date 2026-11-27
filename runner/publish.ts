// Publishes runner activity as AG-UI and sends status, approvals, receipts and alerts on their existing topics.
import { contentToText, EventType } from "@ag-ui/core";
import { broadcastTopic } from "../lib/config.ts";
import { approvalEnd } from "../lib/operator.ts";
import { publish } from "../lib/messaging.ts";
import { publishStatus } from "../lib/messaging.ts";
import { publishActivity } from "../lib/activity.ts";
import { compactionFields } from "../lib/compaction.ts";
import { modelFields } from "../lib/session-events.ts";
import { approvalMessage, cleanQuestions } from "../lib/approvals.ts";
import { sendReceipts } from "../lib/receipts.ts";
import { reportContext } from "../lib/usage.ts";
import { APPROVAL_TIMEOUT_MIN, ERROR, NOTICE } from "./contract.ts";

// A card's expiresAt is when the runner denies it (AI_COLLAB_APPROVAL_TIMEOUT_MIN); this is the default wait.
const DEFAULT_APPROVAL_MS = APPROVAL_TIMEOUT_MIN * 60_000;
const PUBLISH_TIMEOUT_MS = 3000;

// oxlint-disable-next-line typescript/no-explicit-any -- runner events and activity rows are AG-UI JSON
type Json = any;
type Cfg = Parameters<typeof publish>[0];
type Harness = Parameters<typeof publishActivity>[1];
/** An approval card from a harness interrupt. */
export type ApprovalCard = { id: string; tool: unknown; summary: unknown; questions?: unknown };

const withAgent = (row: Json, e: Json): Json => (e.subagentRunId ? { ...row, agent: { id: e.subagentRunId, type: e.metadata?.aiCollab?.subagentType || "" } } : row);

// A compact row; a step carrying metadata.aiCollab.compaction also gets the shared compaction fields.
function compactRow(type: string, meta: Json): Json {
  const fields = meta?.compaction ? compactionFields(meta.compaction) : null;
  const compaction = fields ? { compaction: fields } : {};
  if (type === EventType.STEP_FINISHED) {
    const input = fields?.phase === "failed" ? "compaction failed" : ["compacted", fields?.trigger].filter(Boolean).join(" · ");
    return { type: "compact", input, ...compaction };
  }
  return { type: "compact", input: ["compacting", meta?.note].filter(Boolean).join(" · "), ...compaction };
}

/** Activity rows (lib/activity.ts event shape) for one RunnerEvent; [] when the event has no row on the bus. */
export function activityFor(e: Json, { system }: { system?: boolean } = {}): Json[] {
  const meta = e.metadata?.aiCollab;
  switch (e.type) {
    case EventType.RUN_STARTED: {
      const prompt = contentToText(e.input?.messages.findLast((message: Json) => message.role === "user")?.content);
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
export const sessionEndedRow = (reason?: string): Json => ({ type: "stop", input: ["session ended", reason].filter(Boolean).join(" · ") });

/** The approval envelope of an owned session (lib/approvals.ts shape plus owned:true), or null when it cannot fit. */
export function ownedApprovalMessage(cfg: Cfg, harness: Harness, { id, tool, summary, questions }: ApprovalCard, { now = Date.now(), ttlMs = DEFAULT_APPROVAL_MS }: { now?: number; ttlMs?: number } = {}) {
  const clean = questions === undefined ? undefined : cleanQuestions(questions);
  const req = { tool: String(tool).slice(0, 128), summary: String(summary).slice(0, 300), ...(clean ? { questions: clean } : {}) };
  return approvalMessage(cfg, harness, req, { id, expiresAt: now + ttlMs, ts: new Date(now).toISOString(), owned: true });
}

export function approvalEndMessage(cfg: Cfg, id: string, reason: string) {
  return approvalEnd(cfg, id, reason, { session: cfg.session, owned: true });
}

/** Publishes the owned approval card on the broadcast topic; throws when it cannot fit or publish. */
export async function publishApproval(cfg: Cfg, harness: Harness, card: ApprovalCard, ttlMs?: number): Promise<void> {
  const message = ownedApprovalMessage(cfg, harness, card, { ttlMs });
  if (!message) throw new Error("approval does not fit in one bus message");
  const who = `${cfg.peer}#${cfg.session}`;
  await publish(cfg, broadcastTopic(cfg.project), message, { title: `${card.tool} needs approval for ${who}: ${card.summary}`.slice(0, 200), signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS) });
}

export async function publishApprovalEnd(cfg: Cfg, id: string, reason: string): Promise<void> {
  await publish(cfg, broadcastTopic(cfg.project), approvalEndMessage(cfg, id, reason), { signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS) });
}

/** Activity, status and alert publishes for one event; interrupts go through publishApproval. Never throws. */
export async function publishEvent(cfg: Cfg, harness: Harness, e: Json, options?: { system?: boolean }): Promise<void> {
  try {
    const rows = activityFor(e, options);
    if (rows.length) await publishActivity(cfg, harness, rows, { timeoutMs: PUBLISH_TIMEOUT_MS, run: e });
    if (e.type === EventType.RUN_STARTED) await publishStatus(cfg, { event: "start", harness });
    if (e.type === EventType.RUN_FINISHED || e.type === EventType.RUN_ERROR) await publishStatus(cfg, { event: "stop", harness });
    const tokens = e.type === EventType.STATE_DELTA ? e.delta.find((op: Json) => op.path === "/contextTokens")?.value : undefined;
    if (Number.isSafeInteger(tokens)) await reportContext(cfg, tokens);
  } catch { /* best effort, like hooks */ }
}

/** Publishes the session-ended row and a stop status. Never throws. */
export async function publishEnded(cfg: Cfg, harness: Harness, reason?: string): Promise<void> {
  try {
    await publishActivity(cfg, harness, [sessionEndedRow(reason)], { timeoutMs: PUBLISH_TIMEOUT_MS });
    await publishStatus(cfg, { event: "stop", harness });
  } catch { /* best effort */ }
}

/** Publishes read receipts for message ids the harness accepted. */
export function publishReceipts(cfg: Cfg, ids: string[] | null | undefined): void {
  if (ids?.length) sendReceipts(cfg, ids);
}
