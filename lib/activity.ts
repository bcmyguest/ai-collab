/**
 * Activity events: what each harness's hooks expose about a session's work, published to
 * ai-collab-<project>--activity for the operator UI. Thinking is never read. Text is stripped of
 * control and bidi characters and truncated so each message stays under the 4095-byte wire limit;
 * a larger tool result also travels whole as a .txt attachment.
 */
import { activityTopic } from "./config.mjs";
import { publish, querySafe, type Cfg } from "./messaging.ts";
import { stripControl } from "./format.ts";
import { textAttachment } from "./attachment.ts";
import { MESSAGE_MAX_BYTES } from "./messaging.ts";
import { machinePrompt } from "./mode.ts";
import { envelopeToEvent } from "./agui.mjs";
import { compactionFields } from "./compaction.ts";
import { clearFields, modelFields } from "./session-events.mjs";
import { classifyLimit } from "./limits.ts";

export const ACTIVITY_MAX_BYTES = MESSAGE_MAX_BYTES;
export const ACTIVITY_TIMEOUT_MS = 1500;
export const ACTIVITY_TYPES = ["prompt", "text", "tool_call", "tool_result", "error", "start", "stop", "compact", "clear", "model", "limit", "handoff"];
const HARNESSES = new Set(["claude", "codex", "cursor", "opencode"]);
const NAME_MAX = 128;
const ATTACH_TYPES = new Set(["tool_result", "error"]);
const INSTRUCTIONS_MAX = 200;

const asText = (value: unknown): string => value === undefined || value === null ? ""
  : typeof value === "string" ? value : JSON.stringify(value, null, 2);
const cost = (value: unknown): number => Buffer.byteLength(JSON.stringify(value)) - 2;

// Tool output as readable text: shell stdout and stderr, an output or content string, a read file's content, else JSON.
function resultText(value: unknown): string {
  if (typeof value === "string" && /^\s*[{[]/.test(value)) {
    try { value = JSON.parse(value); } catch { return value as string; }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const { stdout, stderr } = obj;
    if (typeof stdout === "string" || typeof stderr === "string") return [stdout, stderr].filter(Boolean).join("\n");
    if (typeof obj.output === "string") return obj.output;
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.file === "object" && obj.file !== null && typeof (obj.file as Record<string, unknown>).content === "string") return (obj.file as Record<string, unknown>).content as string;
  }
  return asText(value);
}

export interface ActivityEvent {
  type: string;
  tool?: string;
  callId?: string;
  input?: string;
  output?: string;
  system?: boolean;
  agent?: { id: string; type: string };
  compaction?: unknown;
  clear?: unknown;
  modelSwitch?: unknown;
}

export interface ActivityBuildOptions {
  timeoutMs?: number;
  run?: unknown;
}

export interface ActivityMessage {
  message: string;
  attach?: { filename: string; data: Buffer };
}

// Hook input → activity events for one harness; key is the lowercased event name with non-letters removed.
export function activityEvents(host: string, key: string, msg: Record<string, unknown>): ActivityEvent[] {
  const events = hookEvents(host, key, msg);
  // Claude and Codex tag every hook inside a subagent with agent_id and agent_type.
  const id = typeof msg.agent_id === "string" && msg.agent_id ? msg.agent_id : "";
  return id ? events.map(event => ({ ...event, agent: { id, type: typeof msg.agent_type === "string" ? msg.agent_type : "" } })) : events;
}

function hookEvents(host: string, key: string, msg: Record<string, unknown>): ActivityEvent[] {
  const tool = msg.tool_name as string | undefined;
  const callId = (msg.tool_use_id as string) ?? (msg.call_id as string);
  const call: ActivityEvent = { type: "tool_call", tool, input: msg.tool_input as string, callId };
  switch (key) {
    case "sessionstart":
      return [{ type: "start", input: ["session started", msg.source].filter(Boolean).join(" · ") }];
    case "userpromptsubmit":
    case "beforesubmitprompt":
      if (!msg.prompt) return [];
      // Task notifications and agent hand-backs arrive as prompts; show them as agent text, not the operator's.
      return machinePrompt(msg.prompt) ? [{ type: "text", tool: "Agent message", output: msg.prompt as string }] : [{ type: "prompt", input: msg.prompt as string }];
    case "pretooluse":
      return host === "cursor" ? [] : [call];
    case "posttooluse": {
      const result: ActivityEvent = { type: "tool_result", tool, callId, output: resultText(host === "cursor" ? msg.tool_output : msg.tool_response), ...withInput(host, msg) };
      // Cursor gets no preToolUse hook here (its output decides permissions), so the call travels with its result.
      return host === "cursor" ? [call, result] : [result];
    }
    case "posttoolusefailure": {
      const reason = host === "cursor" ? [msg.failure_type as string, msg.error_message as string].filter(Boolean).join(": ") : (msg.error as string);
      const error: ActivityEvent = { type: "error", tool, callId, output: reason || "tool failed", ...withInput(host, msg) };
      return host === "cursor" ? [call, error] : [error];
    }
    case "messagedisplay":
      // Claude streams one message in batches; callId "<message>#<batch>" lets the UI join them in order.
      return msg.delta ? [{ type: "text", output: msg.delta as string, callId: msg.message_id ? `${msg.message_id}#${Number(msg.index) || 0}` : undefined }] : [];
    case "afteragentresponse":
      return msg.text ? [{ type: "text", output: msg.text as string }] : [];
    case "notification":
      return msg.message ? [{ type: "text", tool: "Notification", output: msg.message as string }] : [];
    case "stop": {
      const stop: ActivityEvent = { type: "stop", input: ["turn ended", msg.status].filter(Boolean).join(" · ") };
      // Claude's text arrives through MessageDisplay; Codex exposes only the final message, at Stop.
      return host === "codex" && msg.last_assistant_message ? [{ type: "text", output: msg.last_assistant_message as string }, stop] : [stop];
    }
    case "stopfailure":
      // A limit already has its own timeline row (lib/limit-alert.ts); the error row would repeat it.
      if (classifyLimit("claude", { kind: "stop_failure", ...msg })) return [];
      return [{ type: "error", output: [msg.error as string, msg.error_details as string].filter(Boolean).join(": ") || "API error" }];
    case "subagentstart":
      return [{ type: "start", input: ["subagent started", msg.agent_type].filter(Boolean).join(" · ") }];
    case "subagentstop":
      return [{ type: "stop", input: "subagent finished", output: msg.last_assistant_message as string }];
    case "precompact": {
      const note = typeof msg.custom_instructions === "string" && msg.custom_instructions.length <= INSTRUCTIONS_MAX ? msg.custom_instructions.trim() : "";
      return [{ type: "compact", input: ["compacting", msg.trigger, note].filter(Boolean).join(" · "), compaction: compactionFields({ trigger: msg.trigger as string, phase: "started" }) }];
    }
    case "postmodelswitch": {
      // PostModelSwitch carries the resolved model ids (sdk.d.ts PostModelSwitchHookInput). Not wired in hooks/hooks.json yet.
      const modelSwitch = modelFields({ from: msg.from_model as string, to: msg.to_model as string });
      return modelSwitch ? [{ type: "model", input: `Model ${modelSwitch.from} → ${modelSwitch.to}`, modelSwitch }] : [];
    }
    case "postcompact":
      // PostCompact carries the trigger and the summary (sdk.d.ts:2778); the summary is not published.
      return [{ type: "compact", input: ["compacted", msg.trigger].filter(Boolean).join(" · "), compaction: compactionFields({ trigger: msg.trigger as string, phase: "finished" }) }];
    case "sessionend":
      // SessionEnd with reason "clear" ends the old session's context (sdk.d.ts ExitReason, 7203); the hook script adds tokensBefore from it.
      if (msg.reason === "clear") return [{ type: "clear", input: "cleared", clear: clearFields() }];
      return [{ type: "stop", input: ["session ended", msg.reason].filter(Boolean).join(" · ") }];
    default:
      return [];
  }
}

// A non-Cursor result carries its call's input, so a result whose PreToolUse hook never ran still shows the command.
function withInput(host: string, msg: Record<string, unknown>): { input?: string } {
  return host !== "cursor" && msg.tool_input !== undefined ? { input: msg.tool_input as string } : {};
}

// Longest prefix of value that, with its truncation marker, encodes to at most maxBytes of JSON string content.
function clip(value: string, maxBytes: number): string {
  const total = Buffer.byteLength(value);
  const make = (n: number) => {
    let head = value.slice(0, n);
    if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
    return `${head}…[truncated ${total - Buffer.byteLength(head)} bytes]`;
  };
  let lo = 0;
  let hi = value.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (cost(make(mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return make(lo);
}

/** Fits input and output into max bytes of JSON; the smaller field keeps its share, the larger takes the rest. */
export function fitEnvelope(base: Record<string, unknown>, fields: Record<string, unknown>, max = ACTIVITY_MAX_BYTES, encode = JSON.stringify) {
  const full = { ...base, ...fields };
  if (Buffer.byteLength(encode(full)) <= max) return { envelope: full, clipped: {} };
  const keys = Object.keys(fields).sort((a, b) => cost(fields[a]) - cost(fields[b]));
  let remaining = max - Buffer.byteLength(encode({ ...base, ...Object.fromEntries(keys.map(k => [k, ""])) }));
  const out: Record<string, unknown> = {};
  const clipped: Record<string, boolean> = {};
  keys.forEach((key, i) => {
    const share = Math.floor(remaining / (keys.length - i));
    if (cost(fields[key]) <= share) out[key] = fields[key];
    else { out[key] = clip(fields[key] as string, Math.max(0, share)); clipped[key] = true; }
    remaining -= cost(out[key]);
  });
  return { envelope: { ...base, ...out }, clipped };
}

type ActivityEnvelope = {
  v: number; kind: string; from: string; session?: string; harness: string; ts: string; type: string;
  system?: boolean; tool?: string; callId?: string; agent?: { id: string; type: string };
  compaction?: NonNullable<ReturnType<typeof compactionFields>>;
  clear?: NonNullable<ReturnType<typeof clearFields>>;
  modelSwitch?: NonNullable<ReturnType<typeof modelFields>>;
};

/** One activity event → the bus message (≤ 4095 bytes) plus, for a truncated result, the full text as an attachment. */
export function buildActivity(cfg: Cfg, harness: string, event: ActivityEvent, ts = new Date().toISOString(), run?: unknown): ActivityMessage {
  const base: ActivityEnvelope = {
    v: 1, kind: "activity", from: cfg.peer, ...(cfg.session ? { session: cfg.session } : {}),
    harness: HARNESSES.has(harness) ? harness : "other", ts, type: event.type,
  };
  if (event.system === true) base.system = true;
  if (event.tool) base.tool = stripControl(asText(event.tool)).slice(0, NAME_MAX);
  if (event.callId) base.callId = stripControl(asText(event.callId)).slice(0, NAME_MAX);
  if (event.agent?.id) base.agent = { id: stripControl(event.agent.id).slice(0, NAME_MAX), type: stripControl(event.agent.type || "").slice(0, NAME_MAX) };
  const compaction = event.compaction ? compactionFields(event.compaction) : null;
  if (compaction) base.compaction = compaction;
  if (event.clear) base.clear = clearFields(event.clear);
  const modelSwitch = event.modelSwitch ? modelFields(event.modelSwitch) : null;
  if (modelSwitch) base.modelSwitch = modelSwitch;
  const fields: Record<string, string> = {};
  for (const key of ["input", "output"] as const) {
    const value = stripControl(asText(event[key]));
    if (value) fields[key] = value;
  }
  const id = cfg.wire === "agui" && ATTACH_TYPES.has(event.type) ? globalThis.crypto.randomUUID() : undefined;
  const encode = cfg.wire === "agui"
    ? (envelope: Record<string, unknown>) => JSON.stringify(envelopeToEvent(envelope, { id, run }))
    : JSON.stringify;
  let { envelope, clipped } = fitEnvelope(base, fields, ACTIVITY_MAX_BYTES, encode);
  const attach = clipped.output && ATTACH_TYPES.has(event.type) ? textAttachment(fields.output) : undefined;
  // With an attachment the message travels in the query string, where newline escapes grow from 2 to 6 bytes.
  let message = encode(envelope);
  for (let max = ACTIVITY_MAX_BYTES - 512; max > 0 && attach && Buffer.byteLength(querySafe(message)) > ACTIVITY_MAX_BYTES; max -= 512) {
    ({ envelope } = fitEnvelope(base, fields, max, encode));
    message = encode(envelope);
  }
  if (Buffer.byteLength(message) > ACTIVITY_MAX_BYTES) throw new RangeError("activity metadata exceeds the message limit");
  return { message, ...(attach ? { attach } : {}) };
}

/**
 * Publishes events in order under one deadline (≤ 1.5 s total) and never throws.
 * A failed attachment upload falls back to the truncated message alone.
 */
export async function publishActivity(cfg: Cfg, harness: string, events: ActivityEvent[], { timeoutMs = ACTIVITY_TIMEOUT_MS, run }: ActivityBuildOptions = {}): Promise<number> {
  if (!cfg.enabled || !cfg.activity || !events.length) return 0;
  const signal = AbortSignal.timeout(timeoutMs);
  const topic = activityTopic(cfg.project);
  let sent = 0;
  for (const event of events) {
    if (signal.aborted) break;
    try {
      const { message, attach } = buildActivity(cfg, harness, event, undefined, run);
      try {
        await publish(cfg, topic, message, { attach, signal });
      } catch (error) {
        if (!attach || signal.aborted) throw error;
        await publish(cfg, topic, message, { signal });
      }
      sent += 1;
    } catch { /* best effort */ }
  }
  return sent;
}
