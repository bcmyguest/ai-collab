// AG-UI 1.0 wire discriminators used by the dependency-free hook and MCP codec.
const EventType = Object.freeze({
  CUSTOM: "CUSTOM",
  RUN_STARTED: "RUN_STARTED",
  RUN_FINISHED: "RUN_FINISHED",
  RUN_ERROR: "RUN_ERROR",
  TEXT_MESSAGE_CHUNK: "TEXT_MESSAGE_CHUNK",
  TOOL_CALL_CHUNK: "TOOL_CALL_CHUNK",
  TOOL_CALL_RESULT: "TOOL_CALL_RESULT",
  STEP_STARTED: "STEP_STARTED",
  STATE_SNAPSHOT: "STATE_SNAPSHOT",
  ACTIVITY_SNAPSHOT: "ACTIVITY_SNAPSHOT",
});

const CUSTOM_PREFIX = "ai-collab.";
const ENVELOPE_KINDS = new Set(["activity", "msg", "receipt", "approval", "approval-view", "approval-end", "question", "mode", "status", "alert"]);

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

const string = value => typeof value === "string";
const optionalString = value => value === undefined || string(value);

function problem(event) {
  if (!object(event)) return "expected an event object";
  if (event.timestamp !== undefined && !Number.isSafeInteger(event.timestamp)) return "invalid timestamp";
  if (event.metadata !== undefined && !object(event.metadata)) return "invalid metadata";
  if (!optionalString(event.subagentRunId)) return "invalid subagentRunId";
  switch (event.type) {
    case EventType.CUSTOM:
      return string(event.name) && event.value !== undefined ? null : "name and value required";
    case EventType.RUN_STARTED:
    case EventType.RUN_FINISHED:
      if (!string(event.threadId) || !string(event.runId)) return "threadId and runId required";
      if (!optionalString(event.parentRunId)) return "invalid parentRunId";
      if (event.input !== undefined &&
        (!object(event.input) || !Array.isArray(event.input.messages) ||
          !event.input.messages.every(message => object(message) && string(message.id) && string(message.role)))) return "invalid input";
      if (event.outcome !== undefined &&
        (!object(event.outcome) || !["success", "cancelled", "interrupt"].includes(event.outcome.type) ||
          (event.outcome.type === "interrupt" &&
            (!Array.isArray(event.outcome.interrupts) || !event.outcome.interrupts.length)))) return "invalid outcome";
      return null;
    case EventType.RUN_ERROR:
      return string(event.message) ? null : "message required";
    case EventType.TEXT_MESSAGE_CHUNK:
      return optionalString(event.messageId) && optionalString(event.delta) ? null : "invalid text chunk";
    case EventType.TOOL_CALL_CHUNK:
      return optionalString(event.toolCallId) && optionalString(event.toolCallName) && optionalString(event.delta) ? null : "invalid tool chunk";
    case EventType.TOOL_CALL_RESULT:
      return string(event.messageId) && string(event.toolCallId) && string(event.content)
        ? null : "messageId, toolCallId and content required";
    case EventType.STEP_STARTED:
      return string(event.stepName) ? null : "stepName required";
    case EventType.STATE_SNAPSHOT:
      return event.snapshot !== undefined ? null : "snapshot required";
    case EventType.ACTIVITY_SNAPSHOT:
      return string(event.messageId) && string(event.activityType) && object(event.content) ? null : "messageId, activityType and content required";
    default:
      return "unsupported event type";
  }
}

/** Build an event supported by the wire codec, throwing on a producer error. */
export function buildEvent(type, fields = {}) {
  const event = { ...fields, type };
  const issue = problem(event);
  if (issue) throw new TypeError(issue);
  return event;
}

/** Read untrusted wire JSON or an event object. */
export function parseEvent(raw) {
  const event = read(raw);
  return problem(event) ? null : event;
}

function activityEvent(fields, timestamp, id, run) {
  const { type, callId, input, output, tool, agent } = fields;
  const subagent = typeof agent?.id === "string" && agent.id ? { subagentRunId: agent.id } : {};
  const metadata = (...keys) => ({ aiCollab: Object.fromEntries(Object.entries(fields).filter(([key]) => !keys.includes(key))) });
  const runId = run?.runId ?? run?.metadata?.aiCollab?.runId;
  if (runId && fields.session) {
    const threadId = `${fields.from}#${fields.session}`;
    if (run.type === EventType.RUN_STARTED && type === "prompt" && typeof input === "string") {
      const { parentRunId } = run;
      const lineage = { threadId, runId, ...(parentRunId ? { parentRunId } : {}) };
      const messageId = run.input?.messages.findLast(message => message.role === "user")?.id ?? `${runId}:input`;
      return buildEvent(EventType.RUN_STARTED, {
        ...lineage, timestamp, metadata: metadata("type", "input"),
        input: { ...lineage, tools: [], context: [], messages: [{ id: messageId, role: "user", content: input }] },
      });
    }
    if (run.type === EventType.RUN_FINISHED && type === "stop") {
      return buildEvent(EventType.RUN_FINISHED, {
        threadId, runId, timestamp, outcome: run.outcome, metadata: metadata("type"),
      });
    }
    if (run.type === EventType.RUN_ERROR && type === "error" && typeof output === "string") {
      const meta = metadata("type", "output");
      return buildEvent(EventType.RUN_ERROR, {
        timestamp, message: output, metadata: { aiCollab: { ...meta.aiCollab, runId } },
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
        timestamp, ...subagent, messageId: id ?? globalThis.crypto.randomUUID(), toolCallId: callId, role: "tool", content: output,
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

/** Encode an AI Collab control or messaging event for ntfy. */
export function encodeEnvelope(kind, fields, wire) {
  const envelope = { v: 1, kind, ...fields };
  if (wire !== "agui") return JSON.stringify(envelope);
  const event = envelopeToEvent(envelope);
  if (!event) throw new Error("unknown AI Collab event kind");
  return JSON.stringify(event);
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
  return event ? projectEvent(event) : null;
}

/** Project an already validated event. */
export function projectEvent(event) {
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

/** Read a legacy record or validate an AG-UI event at the wire boundary. */
export function readWireRecord(raw) {
  const value = read(raw);
  return object(value) && value.v === 1 ? value : parseEvent(value);
}

/** Read either wire format during the migration. */
export function parseWireEnvelope(raw) {
  const record = readWireRecord(raw);
  return !record || record.v === 1 ? record : projectEvent(record);
}
