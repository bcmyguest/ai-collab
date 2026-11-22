import { EventType } from "@ag-ui/core";
import { EventSchema } from "@ag-ui/core/schemas";

const CUSTOM_PREFIX = "ai-collab.";
const ENVELOPE_KINDS = new Set(["activity", "msg", "receipt", "approval", "approval-view", "approval-end", "mode", "status", "alert"]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function read(raw) {
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function legacy(value) {
  return object(value) && value.v === 1 && ENVELOPE_KINDS.has(value.kind);
}

/** Build an AG-UI event, throwing on a producer error. */
export function buildEvent(type, fields = {}) {
  return EventSchema.parse({ ...fields, type });
}

/** Read untrusted wire JSON or an event object. */
export function parseEvent(raw) {
  const result = EventSchema.safeParse(read(raw));
  return result.success ? result.data : null;
}

function activityEvent(fields, timestamp, id, run) {
  const { type, callId, input, output, tool, agent } = fields;
  const subagent = typeof agent?.id === "string" && agent.id ? { subagentRunId: agent.id } : {};
  const metadata = (...keys) => ({ aiCollab: Object.fromEntries(Object.entries(fields).filter(([key]) => !keys.includes(key))) });
  if (run?.runId && fields.session) {
    const threadId = `${fields.from}#${fields.session}`;
    if (run.type === EventType.RUN_STARTED && type === "prompt" && typeof input === "string") {
      const { runId, parentRunId } = run;
      const lineage = { threadId, runId, ...(parentRunId ? { parentRunId } : {}) };
      return buildEvent(EventType.RUN_STARTED, {
        ...lineage, timestamp, metadata: metadata("type", "input"),
        input: { ...lineage, messages: [{ id: `${runId}:input`, role: "user", content: input }] },
      });
    }
    if (run.type === EventType.RUN_FINISHED && type === "stop") {
      return buildEvent(EventType.RUN_FINISHED, {
        threadId, runId: run.runId, timestamp, outcome: { type: run.outcome }, metadata: metadata("type"),
      });
    }
    if (run.type === EventType.RUN_ERROR && type === "error" && typeof output === "string") {
      const meta = metadata("type", "output");
      return buildEvent(EventType.RUN_ERROR, {
        timestamp, message: output, metadata: { ...meta, aiCollab: { ...meta.aiCollab, runId: run.runId } },
      });
    }
  }
  if (typeof callId === "string" && callId) {
    if (type === "text" && typeof output === "string" && !tool) {
      return buildEvent(EventType.TEXT_MESSAGE_CHUNK, {
        timestamp, ...subagent, messageId: callId, role: "assistant", delta: output,
        metadata: metadata("type", "callId", "output"),
      });
    }
    if (type === "tool_call" && typeof tool === "string" && tool && (input === undefined || typeof input === "string")) {
      return buildEvent(EventType.TOOL_CALL_CHUNK, {
        timestamp, ...subagent, toolCallId: callId, toolCallName: tool, delta: input,
        metadata: metadata("type", "callId", "tool", "input"),
      });
    }
    if ((type === "tool_result" || type === "error") && typeof output === "string") {
      return buildEvent(EventType.TOOL_CALL_RESULT, {
        timestamp, ...subagent, messageId: id ?? `${callId}:result`, toolCallId: callId, role: "tool", content: output,
        metadata: metadata("callId", "output"),
      });
    }
  }
  if (type === "compact") {
    return buildEvent(EventType.STEP_STARTED, { timestamp, ...subagent, stepName: "compact", metadata: metadata("type") });
  }
  return null;
}

/** Convert a v1 envelope into one AG-UI event. The ntfy ID can identify a legacy tool-result message. */
export function envelopeToEvent(raw, { id, run } = {}) {
  const value = read(raw);
  if (!legacy(value)) return null;
  const { v, kind, ...fields } = value;
  const time = typeof fields.ts === "string" ? Date.parse(fields.ts) : fields.ts;
  const timestamp = Number.isSafeInteger(time) ? time : undefined;
  if (kind === "activity") {
    const event = activityEvent(fields, timestamp, id, run);
    if (event) return event;
  }
  return buildEvent(EventType.CUSTOM, { name: CUSTOM_PREFIX + kind, value: fields, timestamp });
}

function activityFields(event) {
  switch (event.type) {
    case EventType.RUN_STARTED: {
      const prompt = event.input?.messages.findLast(message => message.role === "user")?.content;
      return typeof prompt === "string" ? { type: "prompt", input: prompt } : null;
    }
    case EventType.RUN_FINISHED:
      return { type: "stop" };
    case EventType.RUN_ERROR:
      return { type: "error", output: event.message };
    case EventType.TEXT_MESSAGE_CHUNK:
      return typeof event.messageId === "string" && typeof event.delta === "string"
        ? { type: "text", callId: event.messageId, output: event.delta } : null;
    case EventType.TOOL_CALL_CHUNK:
      return typeof event.toolCallId === "string" && typeof event.toolCallName === "string"
        ? { type: "tool_call", callId: event.toolCallId, tool: event.toolCallName,
            ...(event.delta === undefined ? {} : { input: event.delta }) }
        : null;
    case EventType.TOOL_CALL_RESULT:
      return typeof event.content === "string"
        ? { type: event.metadata?.aiCollab?.type === "error" ? "error" : "tool_result",
            callId: event.toolCallId, output: event.content }
        : null;
    case EventType.STEP_STARTED:
      return event.stepName === "compact" ? { type: "compact" } : null;
    default:
      return null;
  }
}

/** Project an AI Collab event into the v1 envelope consumed by existing readers. */
export function eventToEnvelope(raw) {
  const event = parseEvent(raw);
  if (!event) return null;
  if (event.type === EventType.CUSTOM) {
    if (!event.name.startsWith(CUSTOM_PREFIX) || !object(event.value)) return null;
    const kind = event.name.slice(CUSTOM_PREFIX.length);
    return ENVELOPE_KINDS.has(kind) ? { ...event.value, v: 1, kind } : null;
  }
  const context = event.metadata?.aiCollab;
  if (!object(context) || typeof context.from !== "string") return null;
  const { runId, ...metadata } = context;
  const fields = activityFields(event);
  return fields ? { ...metadata, ...fields, v: 1, kind: "activity" } : null;
}

/** Read either wire format during the migration. */
export function parseWireEnvelope(raw) {
  const value = read(raw);
  return object(value) && value.v === 1 ? value : eventToEnvelope(value);
}
