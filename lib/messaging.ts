/**
 * Messaging: the bus HTTP client (publish, cached poll, stream), send and claim of msg envelopes, the channel and status
 * reads, delivery reservations, and the wait loop (waitUntil, streamWaiter) with the inbox read (readInbox).
 * Every network call goes through the bus client below. Delivery is best-effort: publish failures throw to the caller
 * (CLI) or are swallowed by hooks; there is no outbox or retry (read receipts: lib/receipts.mjs).
 */
import { setTimeout as delay } from "node:timers/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MAX_BODY_CHARS, MESSAGE_MAX_BYTES, SESSION_LABEL, isGithubLogin, isValidName, statusTopic, inboxTopic, broadcastTopic, type loadConfig } from "./config.mjs";
import { deepLink } from "./deep-link.ts";
import { alertPriority, readAlertLevel } from "./alerts.mjs";
import { parsePhoneReply, parseQuestionText } from "./questions.mjs";
import { readState, writeState, statePath, withLock } from "./state.ts";
import { parseMode, recordMode } from "./mode.mjs";
import { imageAttachment, readAttachment } from "./attachment.ts";
import { attachmentOf, cacheAttachmentsWithin, cacheUploadedAttachment, localizedAttachment } from "./attachment-cache.ts";
import { encodeEnvelope, parseWireEnvelope } from "./agui.mjs";
import { sendReceipts, settleReceipts } from "./receipts.mjs";
import { reconnectBackoff } from "./operator.ts";

export { MESSAGE_MAX_BYTES } from "./config.mjs";

export const INITIAL_LOOKBACK_S = 3600; // first contact: deliver messages from the last hour
export const MAX_PER_CLAIM = 20;
export const HISTORY_DEFAULT = 30;
export const HISTORY_MAX = 100;
const HISTORY_TAIL_BYTES = 1024 * 1024; // the newest channel events a history read keeps
const SEEN_MAX = 500;
export const RESERVE_MS = 60_000; // a delivery reservation expires after this, so a crashed pusher cannot hold a message
// A hook may spend this long caching delivered attachments; past it the message arrives with metadata only.
export const ATTACHMENT_BUDGET_MS = 4000;
const HARNESSES = new Set(["claude", "codex", "cursor", "opencode"]);
const MESSAGE_ID = /^[a-zA-Z0-9-]{1,64}$/;
// States of a respond envelope (a msg with replyTo); old clients ignore the field.
export const RESPOND_STATES: readonly string[] = ["working", "reply", "done", "declined"];
// normal wakes an idle session, urgent also polls at the next hook, fyi is queued without a wake.
export const PRIORITIES: readonly string[] = ["normal", "urgent", "fyi"];
// The bus limit on one poll body; a larger body is cut at its last complete line.
const POLL_MAX_BYTES = 256 * 1024;
const STREAM_LINE_MAX = 64 * 1024;
const STREAM_IDLE_MS = 120_000;
const TAIL_READ_MAX_BYTES = 32 * 1024 * 1024;
const STREAM_BACKOFF_MAX_MS = 60_000;
const loggedNtfyErrors = new Set<string>();
// The chat an @mention came from: "all" (the project chat) or a session address.
const MENTIONED_IN = /^(all|[a-z0-9-]{1,24}#[a-f0-9]{16})$/;
// The run ID of a subagent that an @mention names; the parent session relays it.
const SUBAGENT_RUN = /^[A-Za-z0-9_-]{1,64}$/;
// A team name when the operator routed work to a team orchestrator.
const TEAM_NAME = /^(?=.{1,24}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const THREAD_ID = /^th_[a-f0-9]{16}$/;
// A project-chat @tag: a harness, harness#session, harness#session/run, or harness:model.
const AGENT_MENTION = /(^|[^\w#-])@([a-z0-9-]{1,24}(?:#[a-f0-9]{16}(?:\/[A-Za-z0-9_-]{1,64})?|:[A-Za-z0-9][A-Za-z0-9._/-]{0,119})?)(?![\w-])/g;

// The loaded config; a disabled one carries only enabled and reason.
export type Cfg = Omit<Extract<ReturnType<typeof loadConfig>, { project: string }>, "peers"> & { peers: string[]; enabled?: boolean; reason?: string; parent?: string };
type Claim = typeof claimInbox;
type Envelope = { kind?: string; [key: string]: unknown };
export type Message = { id: string; [key: string]: unknown };
export type InboxMessage = { id: string; from: string; to: string; ts: string; body: string; attachment?: unknown; [key: string]: unknown };
export type TransportEvent = { id: string; time: number; topic: string; message: string; title?: string; attachment?: Attachment; reset?: true };
export type Attachment = { name: string; type: string; size: number; url: string };
export type Outcome = "event" | "timeout" | "error" | "aborted" | "queued";
export type Step = (ms: number, signal?: AbortSignal) => Promise<Outcome>;
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
export type WaitResult<T> = { status: "hit"; value: T } | { status: "timeout" } | { status: "aborted" } | { status: "queued" };
export type WaitOptions<T> = {
  deadline: number;
  signal?: AbortSignal;
  until: (first: boolean) => Promise<T | undefined>;
  stream?: Step;
  poll?: { intervalMs: number; sleep?: Sleep };
  checkFirst?: boolean;
  alive?: () => boolean;
  errorPauseMs?: number;
  now?: () => number;
};
export type ReadOptions = { peek?: boolean; strict?: boolean; limit?: number; accept?: (m: InboxMessage) => boolean; receipts?: boolean; settle?: boolean; claim?: Claim };
export type SendOptions = {
  operatorThread?: boolean; system?: boolean; replyTo?: string; attachment?: AttachmentInput; urgent?: boolean; state?: string; by?: string;
  mentionedIn?: string; forSubagent?: string; forTeam?: string; priority?: string; expectReply?: boolean; startOnly?: boolean; threadId?: string; onPublished?: (ev: TransportEvent) => void;
};
// A file path, or an image held in memory under a file name.
export type AttachmentInput = string | { filename: string; data: Buffer };
export type ClaimOptions = {
  now?: number; throttle?: boolean; commit?: boolean; strict?: boolean; limit?: number; accept?: (m: InboxMessage) => boolean;
  poll?: Map<string, Promise<TransportEvent[]>> | null; peek?: PeekState | null; limited?: Set<string> | null;
};
export type PeekState = { lane: string; cursors: Map<string, { base: string; id: string }> };
type InboxState = {
  lastPollAt: number; seen: string[]; topics: Record<string, unknown>; reserved: Record<string, unknown>;
  queue?: Record<string, Record<string, unknown> & { cancelled?: boolean }>; [key: string]: unknown;
};
type Fetched = Map<string, { events?: TransportEvent[]; error?: unknown }>;

/** Waits until until() returns a value, the deadline passes, alive() turns false, or the signal aborts. Each step waits on stream or poll. */
export async function waitUntil<T>(o: WaitOptions<T>): Promise<WaitResult<T>> {
  const now = o.now ?? Date.now;
  for (let first = true; ; first = false) {
    if (!(first && o.checkFirst === false)) {
      const value = await o.until(first);
      if (value !== undefined) return { status: "hit", value };
      if (o.signal?.aborted) return { status: "aborted" };
      if (o.alive && !o.alive()) return { status: "timeout" };
    }
    if (o.signal?.aborted) return { status: "aborted" };
    const remaining = o.deadline - now();
    if (remaining <= 0) return { status: "timeout" };
    const outcome = await nextStep(o, remaining);
    if (outcome === "aborted" || o.signal?.aborted) return { status: "aborted" };
    if (outcome === "queued") return { status: "queued" };
    if (outcome === "error" && o.errorPauseMs) await delay(Math.min(o.errorPauseMs, Math.max(0, o.deadline - now())));
  }
}

// One wait of at most ms: the stream step, or a poll sleep capped at the poll interval.
function nextStep<T>(o: WaitOptions<T>, ms: number): Promise<Outcome> {
  if (o.stream) return o.stream(ms, o.signal);
  const poll = o.poll ?? { intervalMs: ms };
  const sleep = poll.sleep ?? ((d: number, sig?: AbortSignal) => delay(d, undefined, { signal: sig }));
  return sleep(Math.min(poll.intervalMs, ms), o.signal).then(() => "timeout" as const, () => "timeout" as const);
}

/** Waiter on this peer's inbox and broadcast topics. wait(ms) resolves "event" on the first new event, "timeout" after ms, or "error" after an exponential backoff (stopPollMs doubling to 60 s) when the stream fails. */
export function streamWaiter(cfg: Cfg, startMs: number): Step {
  let since = String(Math.floor(startMs / 1000));
  const backoff = reconnectBackoff(cfg.stopPollMs, STREAM_BACKOFF_MAX_MS);
  return async (ms, signal) => {
    const ctrl = new AbortController();
    signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms);
    try {
      const topics = [inboxTopic(cfg.project, cfg.peer), broadcastTopic(cfg.project)];
      for await (const ev of streamEvents(cfg, topics, { since, signal: ctrl.signal, onOpen: () => backoff.reset() })) {
        since = ev.id;
        return "event";
      }
    } catch { /* timeout, outage, or HTTP error such as 429 */ } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
    if (timedOut) return "timeout";
    if (signal?.aborted) return "aborted";
    await backoff.wait(signal, ms);
    return "error";
  };
}

/** Claims new messages for this session (peek leaves them unread), then publishes read receipts; receipts default to claims only. */
export async function readInbox(cfg: Cfg, { peek = false, strict = true, limit, accept, receipts = !peek, settle = true, claim = claimInbox }: ReadOptions = {}) {
  const messages = await claim(cfg, { commit: !peek, strict, limit, accept });
  if (receipts) {
    sendReceipts(cfg, messages.map((m: Message) => m.id));
    if (settle) await settleReceipts();
  }
  return messages;
}

/**
 * ntfy turns the two characters \n of a query-string message into a newline, which breaks JSON string escapes.
 * For a JSON message, respell \n and \\ as \u000a and \: the same JSON value, safe through the query string.
 */
export function querySafe(message: string): string {
  try { JSON.parse(message); } catch { return message; }
  return message.replace(/\\(\\|n)/g, (_, c: string) => (c === "n" ? "\\u000a" : "\\u005c"));
}

// The request timeout, or the caller's deadline when that ends sooner.
function withSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

function headers(cfg: Cfg, extra: Record<string, string> = {}) {
  const h = { ...extra };
  if (cfg.token) h.authorization = `Bearer ${cfg.token}`;
  return h;
}

type PublishOptions = { title?: string; attach?: { filename: string; data: Buffer }; signal?: AbortSignal; priority?: string | number; click?: string; threadId?: string; onPublished?: (ev: TransportEvent) => void };

/** Publishes one message; resolves with the new event's id (true when ntfy's answer carries none). */
export async function publish(cfg: Cfg, topic: string, message: string, { title, attach, signal, priority, click, threadId, onPublished }: PublishOptions = {}): Promise<string | true> {
  // An attachment is the request body; ntfy then takes message and title from the query string.
  const query = attach && new URLSearchParams({
    message: querySafe(message), filename: attach.filename,
    ...(title ? { title } : {}), ...(click ? { click } : {}), ...(priority ? { priority: String(priority) } : {}), ...(threadId ? { thread_id: threadId } : {}),
  });
  const res = attach
    ? await fetch(`${cfg.url}/${topic}?${query}`, {
      method: "PUT", headers: headers(cfg), body: attach.data as BodyInit, signal: withSignal(signal, cfg.timeoutMs * 4),
    })
    : await fetch(`${cfg.url}/`, {
      method: "POST",
      headers: headers(cfg, { "content-type": "application/json" }),
      body: JSON.stringify({ topic, message, ...(title ? { title } : {}), ...(priority ? { priority } : {}), ...(click ? { click } : {}), ...(threadId ? { thread_id: threadId } : {}) }),
      signal: withSignal(signal, cfg.timeoutMs),
    });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw Object.assign(new Error(`publish failed: HTTP ${res.status}`), { ntfyStatus: res.status });
  const id = publishedId(text);
  const published = attach || onPublished ? messageEvent(text) : undefined;
  if (attach && published) {
    try { cacheUploadedAttachment(cfg, published, attach); } catch { /* upload already succeeded */ }
  }
  if (id && onPublished) {
    const event = published || { id, message, title, time: Math.floor(Date.now() / 1000) };
    onPublished({ ...event, topic });
  }
  return id || true;
}

// The id of the event ntfy answers a publish with, or "".
function publishedId(text: string): string {
  try {
    const id = JSON.parse(text)?.id;
    return typeof id === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(id) ? id : "";
  } catch {
    return "";
  }
}

async function readBounded(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      chunks.push(value.subarray(0, value.length - (total - maxBytes)));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  let text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  // Drop a partial trailing line so only complete JSON lines are parsed.
  if (truncated) text = text.slice(0, text.lastIndexOf("\n") + 1);
  return text;
}

// Keeps the newest complete lines within keepBytes; stops reading after TAIL_READ_MAX_BYTES.
async function readTail(res: Response, keepBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let kept = 0;
  let partial = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    const parts = (partial + decoder.decode(value, { stream: true })).split("\n");
    partial = parts.pop() ?? "";
    for (const line of parts) {
      lines.push(line);
      kept += line.length + 1;
    }
    while (kept > keepBytes && lines.length) kept -= (lines.shift() ?? "").length + 1;
    if (total > TAIL_READ_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Cached read: GET /<topic>/json?poll=1&since=<id|unix-seconds|duration>.
 * Returns only "message" events, oldest first. tailBytes keeps the newest events instead of the oldest.
 */
export async function pollCached(cfg: Cfg, topic: string, since: string, signal?: AbortSignal, { tailBytes = 0 }: { tailBytes?: number } = {}): Promise<TransportEvent[]> {
  const url = `${cfg.url}/${encodeURIComponent(topic)}/json?poll=1&since=${encodeURIComponent(since)}`;
  const timeout = AbortSignal.timeout(cfg.timeoutMs);
  const res = await fetch(url, { headers: headers(cfg), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!res.ok) {
    logNtfyErrorOnce(res.status, await res.text().catch(() => ""));
    throw Object.assign(new Error(`poll failed: HTTP ${res.status}`), { ntfyStatus: res.status });
  }
  const text = tailBytes ? await readTail(res, tailBytes) : await readBounded(res, POLL_MAX_BYTES);
  return text.split("\n").map(messageEvent).filter((ev): ev is TransportEvent => ev !== null);
}

// The JSON error body of an ntfy response, or {} when the body is not JSON.
function ntfyErrorOf(body: string) {
  try { return JSON.parse(body) ?? {}; } catch { return {}; }
}

// Writes one stderr line per distinct ntfy status and error code: "ntfy HTTP 429 code 42905: <error>".
function logNtfyErrorOnce(status: number, body: string): void {
  const parsed = ntfyErrorOf(body);
  const key = `${status}:${parsed.code ?? ""}`;
  if (loggedNtfyErrors.has(key)) return;
  loggedNtfyErrors.add(key);
  const code = parsed.code ? ` code ${parsed.code}` : "";
  const error = typeof parsed.error === "string" ? `: ${parsed.error}` : "";
  process.stderr.write(`ai-collab: ntfy HTTP ${status}${code}${error}\n`);
}

function messageEvent(line: string): TransportEvent | null {
  if (!line.trim()) return null;
  let ev;
  try { ev = JSON.parse(line); } catch { return null; }
  if (!ev || ev.event !== "message" || typeof ev.id !== "string" || typeof ev.message !== "string") return null;
  const a = ev.attachment;
  const attachment = a && typeof a.url === "string"
    ? { name: String(a.name || ""), type: String(a.type || ""), size: Number(a.size) || 0, url: a.url }
    : undefined;
  // The title carries who sent a UI reply (web/server/ui.mjs replyTitle).
  const title = typeof ev.title === "string" && ev.title ? { title: ev.title.slice(0, 200) } : {};
  const reset = ev.reset === true ? { reset: true as const } : {};
  return { id: ev.id, time: Number(ev.time) || 0, topic: ev.topic, message: ev.message, ...title, ...(attachment ? { attachment } : {}), ...reset };
}

// The stream's first line is its open line; reset: true there means the bus replayed from the oldest event.
function openedWithReset(line: string): boolean {
  try { return JSON.parse(line)?.reset === true; } catch { return false; }
}

/**
 * Streaming read of GET /<topic1>,<topic2>/json?since=…; yields message events until close, idle, or abort.
 * onReset() runs once when the bus flags the replay (an unknown since): the events then carry the replayed backlog.
 */
export async function* streamEvents(cfg: Cfg, topics: string[], { since = "", signal, onOpen, onReset }: { since?: string; signal?: AbortSignal; onOpen?: () => void; onReset?: () => void } = {}): AsyncGenerator<TransportEvent> {
  const ctrl = new AbortController();
  const abort = () => ctrl.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  let timer = setTimeout(() => ctrl.abort(new Error("subscribe timed out")), cfg.timeoutMs);
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(new Error("subscription idle")), STREAM_IDLE_MS);
  };
  try {
    const query = since ? `?since=${encodeURIComponent(since)}` : "";
    const res = await fetch(`${cfg.url}/${topics.map(encodeURIComponent).join(",")}/json${query}`, {
      headers: headers(cfg), signal: ctrl.signal,
    });
    if (!res.ok) {
      await res.arrayBuffer().catch(() => {});
      throw Object.assign(new Error(`subscribe failed: HTTP ${res.status}`), { ntfyStatus: res.status });
    }
    arm();
    onOpen?.();
    let buffer = "";
    let first = true;
    const body = res.body;
    if (!body) throw new Error("subscribe response has no body");
    for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
      arm();
      const lines = (buffer + chunk).split("\n");
      buffer = lines.pop() ?? "";
      if (buffer.length > STREAM_LINE_MAX) throw new Error("subscription line too long");
      for (const line of lines) {
        if (first && line.trim()) {
          first = false;
          if (openedWithReset(line)) onReset?.();
        }
        const ev = messageEvent(line);
        if (ev) yield ev;
      }
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    ctrl.abort();
  }
}

// The sender's session label when the envelope carries a valid one, else "".
function sessionOf(m: Envelope): string {
  return typeof m.session === "string" && SESSION_LABEL.test(m.session) ? m.session : "";
}

// A sender or recipient address: the harness, or harness#session when a session is named.
function addressOf(peer: string, session: string): string {
  return session ? `${peer}#${session}` : peer;
}

// The envelope timestamp when it is short and plain, else "".
function timestampOf(m: Envelope): string {
  return typeof m.ts === "string" && /^[\w:.+-]{1,40}$/.test(m.ts) ? m.ts : "";
}

function envelope(cfg: Cfg, kind: string, fields: Record<string, unknown>): string {
  return encodeEnvelope(kind, { from: cfg.peer, ...(cfg.session ? { session: cfg.session } : {}), ...fields }, cfg.wire);
}

export function parseEnvelope(raw: string | undefined): Envelope | null {
  return parseWireEnvelope(raw);
}

/** Status carries metadata only: peer, event, harness, time. No paths, prompts, or output. */
export async function publishStatus(cfg: Cfg, { event, harness }: { event: string; harness: string }): Promise<void> {
  const h = HARNESSES.has(harness) ? harness : "other";
  const msg = envelope(cfg, "status", { event, harness: h, ...(cfg.parent ? { parent: cfg.parent } : {}), ts: new Date().toISOString() });
  await publish(cfg, statusTopic(cfg.project), msg, { title: "ai-collab status", priority: alertPriority(readAlertLevel(), "other") });
}

/**
 * Sends one msg envelope; resolves {topic, id}. urgent marks it for delivery at the recipient's next hook (markUrgent);
 * state (with replyTo) answers a message as working, reply, done or declined; by names the operator's GitHub login;
 * forSubagent names the subagent run (of the target session) that the message is for.
 * priority is normal, urgent (same as urgent: true) or fyi (queued, never wakes an idle session);
 * expectReply marks a direct message the dispatcher redelivers until the target answers (web/server/dispatch.mjs);
 * system marks text ai-collab's own machinery sends (a compaction request, a pattern-run notice) under the operator's
 * address: it reaches the operator's own reply routes, but readers show the sender as "system", not as the operator.
 * startOnly marks a project-chat post that only starts sessions, so no running session takes it.
 */
export async function sendMessage(cfg: Cfg, target: string, body: string, { operatorThread, system, replyTo, attachment, urgent, state, by, mentionedIn, forSubagent, forTeam, priority, expectReply, startOnly, threadId, onPublished }: SendOptions = {}) {
  if (!cfg.enabled) throw new Error(`disabled: ${cfg.reason}`);
  const [peer, session, ...extra] = String(target).split("#");
  if (!isValidName(peer) || extra.length || (session !== undefined && (peer === "all" || !SESSION_LABEL.test(session)))) {
    throw new Error(`invalid peer name "${target}"`);
  }
  if (peer !== "all" && cfg.peers.length && !cfg.peers.includes(peer)) {
    throw new Error(`peer "${target}" is not in AI_COLLAB_PEERS`);
  }
  if (typeof body !== "string" || (!body.trim() && attachment === undefined)) throw new Error("empty message");
  if (body.length > MAX_BODY_CHARS) throw new Error(`message is over ${MAX_BODY_CHARS} characters`);
  const topic = peer === "all" ? broadcastTopic(cfg.project) : inboxTopic(cfg.project, peer);
  if (operatorThread && (cfg.peer !== "operator" || !session)) throw new Error("Direct chats require a session");
  if (replyTo !== undefined && !MESSAGE_ID.test(replyTo)) throw new Error("invalid reply_to message ID");
  if (state !== undefined && (!RESPOND_STATES.includes(state) || !replyTo)) throw new Error("state must be working, reply, done or declined, with reply_to");
  if (by !== undefined && (cfg.peer !== "operator" || !isGithubLogin(by))) throw new Error("by must be a GitHub login on an operator message");
  if (system !== undefined && (system !== true || cfg.peer !== "operator")) {
    throw new Error("system messages are ai-collab's own, sent from the operator address");
  }
  if (mentionedIn !== undefined && !MENTIONED_IN.test(mentionedIn)) throw new Error("invalid mentionedIn chat");
  if (forSubagent !== undefined && !SUBAGENT_RUN.test(forSubagent)) throw new Error("invalid forSubagent run ID");
  if (forTeam !== undefined && !TEAM_NAME.test(forTeam)) throw new Error("invalid forTeam name");
  if (priority !== undefined && !PRIORITIES.includes(priority)) throw new Error("priority must be normal, urgent or fyi");
  if (priority === "fyi" && urgent === true) throw new Error("a message cannot be both fyi and urgent");
  if (expectReply !== undefined && typeof expectReply !== "boolean") throw new Error("expect_reply must be true or false");
  if (expectReply === true && (peer === "all" || priority === "fyi")) throw new Error("expect_reply needs a direct, non-fyi message");
  if (startOnly !== undefined && typeof startOnly !== "boolean") throw new Error("start_only must be true or false");
  if (startOnly === true && peer !== "all") throw new Error("start_only needs the project chat");
  if (threadId !== undefined && (cfg.peer !== "operator" || !THREAD_ID.test(threadId))) throw new Error("threadId must be a thread id on an operator message");
  if (priority === "urgent") urgent = true;
  const sent = await sendEnvelope(cfg, topic, {
    to: peer, ...(session ? { toSession: session } : {}), ts: new Date().toISOString(), body,
    ...(operatorThread ? { operatorThread: true } : {}),
    ...(system === true ? { system: true } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(state ? { state } : {}),
    ...(urgent === true ? { urgent: true } : {}),
    ...(priority === "fyi" ? { priority } : {}),
    ...(expectReply === true ? { expectReply: true } : {}),
    ...(startOnly === true ? { startOnly: true } : {}),
    ...(by ? { by } : {}),
    ...(mentionedIn ? { mentionedIn } : {}),
    ...(forSubagent ? { forSubagent } : {}),
    ...(forTeam ? { forTeam } : {}),
    ...(threadId ? { threadId } : {}),
  }, { attachment, onPublished, threadId });
  if (urgent === true) markUrgent(cfg, String(target));
  return sent;
}

function urgentFile(cfg: Cfg, target: string): string {
  return path.join(cfg.stateDir, cfg.project, "urgent", target);
}

/**
 * Records that an urgent message for target (all, peer, or peer#session) was published. Hooks on this machine read
 * the marker before their poll throttle, so the next hook event polls the bus at once. Best effort: errors are ignored.
 */
export function markUrgent(cfg: Cfg, target: string, now = Date.now()): void {
  try {
    const file = urgentFile(cfg, target);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, String(now), { mode: 0o600 });
  } catch { /* the message still arrives at the next unthrottled poll */ }
}

/** True when an urgent message for this peer or session was marked after `at` (ms). Costs up to three small file reads. */
export function urgentSince(cfg: Cfg, at: number): boolean {
  const targets = ["all", cfg.peer, ...(cfg.session ? [`${cfg.peer}#${cfg.session}`] : [])];
  return targets.some((target) => {
    try { return Number(readFileSync(urgentFile(cfg, target), "utf8")) > at; } catch { return false; }
  });
}

async function sendEnvelope(cfg: Cfg, topic: string, fields: Record<string, unknown>, { attachment, onPublished, threadId }: { attachment?: AttachmentInput; onPublished?: (ev: TransportEvent) => void; threadId?: string } = {}) {
  const msg = envelope(cfg, "msg", fields);
  // With an attachment the message travels in the query string, respelled by querySafe.
  if (Buffer.byteLength(attachment === undefined ? msg : querySafe(msg)) > MESSAGE_MAX_BYTES) {
    throw new Error(`encoded message exceeds the ${MESSAGE_MAX_BYTES}-byte wire limit`);
  }
  const attach = attachment === undefined ? undefined
    : typeof attachment === "object" && Buffer.isBuffer(attachment.data) && typeof attachment.filename === "string"
      ? imageAttachment(attachment.filename, attachment.data) : readAttachment(attachment);
  const from = addressOf(cfg.peer, cfg.session);
  // deep-link.mjs infers its parameter type without project; the call passes it.
  const link = { project: cfg.project, session: cfg.session ? from : "" };
  const click = deepLink(link);
  const id = await publish(cfg, topic, msg, { title: `ai-collab from ${from}`, attach, onPublished, click, priority: alertPriority(readAlertLevel(), "direct"), ...(threadId ? { threadId } : {}) });
  return { topic, ...(typeof id === "string" ? { id } : {}) };
}

export async function replyToOperator(cfg: Cfg, id: string, body: string, { attachment, state }: { attachment?: AttachmentInput; state?: string } = {}) {
  if (!cfg.session || typeof id !== "string" || !MESSAGE_ID.test(id)) {
    throw new Error("Use the session and message ID supplied by the ai-collab hook");
  }
  if (typeof body !== "string" || !body.trim() || body.length > MAX_BODY_CHARS) {
    throw new Error("Enter 1–4000 characters");
  }
  const topic = inboxTopic(cfg.project, cfg.peer);
  const history = await pollCached(cfg, topic, "all");
  const original = parseEnvelope(history.find((event) => event.id === id)?.message);
  if (original?.kind !== "msg" || original.from !== "operator" || original.operatorThread !== true ||
      original.to !== cfg.peer || original.toSession !== cfg.session) {
    throw new Error("This operator message is unavailable for your session");
  }
  if (state !== undefined && !RESPOND_STATES.includes(state)) throw new Error("state must be working, reply, done or declined");
  await sendEnvelope(cfg, topic, {
    to: "operator", operatorThread: true, replyTo: id, ts: new Date().toISOString(), body, ...(state ? { state } : {}),
  }, { attachment });
  return { sent: true };
}

/**
 * True when a project-chat body addresses this agent. `@peer` names the harness and wakes every session of it.
 * `@peer#session` (and `@peer#session/run`) names that session. A `@peer:model` tag starts a new session and does not.
 */
export function mentionsAgent(body: string, { peer, session }: { peer?: string; session?: string } = {}): boolean {
  if (!peer) return false;
  const address = session ? `${peer}#${session}` : "";
  for (const match of String(body).matchAll(AGENT_MENTION)) {
    const name = match[2].replace(/\.+$/, "");
    if (name === peer) return true;
    if (address && (name === address || name.startsWith(`${address}/`))) return true;
  }
  return false;
}

/**
 * Read new messages for this peer (direct inbox plus broadcast).
 * - throttle: skip the network if the last poll was < pollIntervalMs ago (hot hooks), unless an urgent marker is newer.
 * - commit: false = peek, no cursor or dedup writes.
 * - strict: rethrow errors and lock contention instead of returning [] (CLI).
 * Cursors advance only past events that were processed, so a cap or failure
 * leaves the remainder for the next claim.
 * An agent session (cfg.session set) takes a project-chat post only when mentionsAgent matches.
 * A direct message, including one to the peer inbox, is always taken. A claim with no session is the
 * peer inbox and still sees the channel. Phone alert priority is unchanged.
 */
export async function claimInbox(cfg: Cfg, opts: ClaimOptions = {}): Promise<InboxMessage[]> {
  const { now = Date.now(), throttle = false, commit = true, strict = false, limit = MAX_PER_CLAIM, accept = () => true, poll = null, peek = null, limited = null } = opts;
  if (!cfg.enabled) return [];
  const file = statePath(cfg);
  const inbox = inboxTopic(cfg.project, cfg.peer);
  const all = broadcastTopic(cfg.project);
  const snapshot = readState(file) as InboxState;
  if (throttle && cfg.pollIntervalMs > 0 && now - snapshot.lastPollAt < cfg.pollIntervalMs && !urgentSince(cfg, snapshot.lastPollAt)) return [];
  // Network reads run before the lock; the lock covers only the state read, the apply and the write.
  const fetched = await fetchTopics(cfg, snapshot, [inbox, all], now, { poll, peek, file, limited });
  const apply = (state: InboxState) => applyEvents(cfg, state, fetched, { inbox, all, now, limit, accept, strict });
  if (!commit) {
    try {
      const state = readState(file) as InboxState;
      const out = apply(state);
      if (peek && out.length === 0) recordPeek(peek, file, snapshot, fetched, state, [inbox, all]);
      return out;
    } catch (err) {
      if (strict) throw err;
      return [];
    }
  }
  try {
    const r = await underLock(file, () => {
      const state = readState(file) as InboxState;
      state.lastPollAt = now;
      const out = apply(state);
      state.reserved = Object.fromEntries(Object.entries(state.reserved).filter(([, v]) => untilOf(v) > now));
      writeState(file, state);
      return out;
    });
    if (!r.locked) {
      if (strict) throw new Error("another ai-collab process holds the inbox lock; retry");
      return [];
    }
    // A delivered attachment is cached once for the whole machine, outside the lock and under a short budget,
    // so the agent reads the file the UI already has instead of downloading it from ntfy again.
    return r.value.some((m) => m.attachment && !(m.attachment as { local_path?: string }).local_path)
      ? await cacheAttachmentsWithin(cfg, r.value, { budgetMs: ATTACHMENT_BUDGET_MS }) as InboxMessage[]
      : r.value;
  } catch (err) {
    if (strict) throw err;
    return [];
  }
}

// Queue changes share the inbox lock with hook claims and push reservations.
export async function changeQueuedMessage(cfg: Cfg, id: string, change: Record<string, unknown>): Promise<boolean> {
  const file = statePath(cfg);
  const result = await withInboxLock(file, () => {
    const state = readState(file) as InboxState;
    if (state.seen.includes(id) || untilOf(state.reserved[id]) > Date.now() || state.queue?.[id]?.cancelled) return false;
    state.queue = { ...state.queue, [id]: { ...state.queue?.[id], ...change } };
    writeState(file, state);
    return true;
  });
  return result.locked && result.value;
}

export function queuedMessage<M extends { id: string }>(message: M, state: InboxState): M | null {
  const change = state.queue?.[message.id];
  return change?.cancelled ? null : change ? { ...message, ...change } : message;
}

// A push can peek before an edit, so resolve its payload again after reserving.
export function reservedMessage<M extends { id: string }>(cfg: Cfg, message: M): M | null {
  return queuedMessage(message, readState(statePath(cfg)) as InboxState);
}

function committedId(state: InboxState, topic: string): string {
  const cur = state.topics[topic];
  return cur && typeof cur === "object" && typeof (cur as { id?: unknown }).id === "string" ? (cur as { id: string }).id : "";
}

// A peek is a read position per lane (live or wake path), state file and topic: each path refuses different messages.
function peekKey(lane: string, file: string, topic: string): string {
  return `${lane}\n${file}\n${topic}`;
}

// Polls each topic from the peek position while it still follows the committed cursor, else from the committed cursor.
// A failed topic is kept as its error (fail open per topic). poll memoizes reads by topic and since across sessions in one tick.
// limited holds the topics that answered 429 earlier in the tick: they are not polled again.
async function fetchTopics(cfg: Cfg, state: InboxState, topics: string[], now: number, { poll = null, peek = null, file = "", limited = null }: { poll?: ClaimOptions["poll"]; peek?: PeekState | null; file?: string; limited?: Set<string> | null } = {}): Promise<Fetched> {
  const fetched: Fetched = new Map();
  for (const topic of topics) {
    if (limited?.has(topic)) {
      fetched.set(topic, { error: Object.assign(new Error("topic rate limited earlier this tick"), { ntfyStatus: 429 }) });
      continue;
    }
    const committed = committedId(state, topic);
    const peeked = peek?.cursors.get(peekKey(peek.lane, file, topic));
    const since = peeked && peeked.base === committed ? peeked.id : committed || String(Math.floor(now / 1000) - INITIAL_LOOKBACK_S);
    try {
      const key = `${topic}\n${since}`;
      let read = poll?.get(key);
      if (!read) {
        read = pollCached(cfg, topic, since).then((events) => {
          if (events.some((e) => e.reset)) process.stderr.write(`ai-collab: bus replayed ${topic} from the oldest event (unknown cursor)\n`);
          return events;
        });
        poll?.set(key, read);
      }
      fetched.set(topic, { events: await read });
    } catch (err) {
      fetched.set(topic, { error: err });
      if ((err as { ntfyStatus?: number }).ntfyStatus === 429) limited?.add(topic);
    }
  }
  return fetched;
}

// After a peek that returned nothing, moves the in-memory read position past the events it examined, so an idle
// session stops re-reading the same broadcast backlog. Only memory: the committed cursor is never written here.
function recordPeek(peek: PeekState, file: string, snapshot: InboxState, fetched: Fetched, state: InboxState, topics: string[]): void {
  for (const topic of topics) {
    if (fetched.get(topic)?.error) continue;
    const id = committedId(state, topic);
    const base = committedId(snapshot, topic);
    if (id && id !== base) peek.cursors.set(peekKey(peek.lane, file, topic), { base, id });
  }
}

// Applies fetched events to state: cursor, seen ids, mode, and the messages this session takes.
// A reserved id belongs to a push in flight: the cursor stops before it, so a failed push can still deliver it.
// accept(message) decides whether a message counts toward limit; a refused one is neither returned nor counted.
function applyEvents(cfg: Cfg, state: InboxState, fetched: Fetched, { inbox, all, now, limit, accept, strict }: { inbox: string; all: string; now: number; limit: number; accept: (m: InboxMessage) => boolean; strict: boolean }): InboxMessage[] {
  const seen = new Set(state.seen);
  const reserved = new Set(liveReserved(state, now));
  const out: InboxMessage[] = [];
  let lastError;
  const add = (message: InboxMessage) => {
    if (accept(message)) out.push(message);
  };
  for (const topic of [inbox, all]) {
    if (out.length >= limit) break;
    const f = fetched.get(topic);
    if (!f) continue;
    if (f.error) {
      lastError = f.error;
      continue;
    }
    const cur = (state.topics[topic] && typeof state.topics[topic] === "object" ? state.topics[topic] : {}) as { id?: string };
    state.topics[topic] = cur;
    for (const ev of f.events ?? []) {
      if (out.length >= limit) break;
      if (reserved.has(ev.id)) break;
      cur.id = ev.id;
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      const m = parseEnvelope(ev.message);
      if ((!m || m.kind === "question") && topic === all && ev.message.trim() && !parsePhoneReply(ev.message)) {
        const question = parseQuestionText(m || ev.message);
        if (m && !question) continue;
        if (question && cfg.session && question.sender === `${cfg.peer}#${cfg.session}`) continue; // own question
        const text = (question?.text ?? ev.message).slice(0, MAX_BODY_CHARS);
        // Channel text wakes an agent session only when it @mentions that session or its harness.
        if (cfg.session && !mentionsAgent(text, cfg)) continue;
        add({
          id: ev.id, from: "ntfy", to: "all", ts: "", body: text,
          ...(question ? {} : { operatorBroadcast: true }),
        });
        continue;
      }
      if (topic === all && m?.kind === "mode") {
        recordMode(state, parseMode(m));
        continue;
      }
      if (!m || m.kind !== "msg" || typeof m.body !== "string") continue;
      if (!isValidName(m.from)) continue;
      const senderSession = sessionOf(m);
      if (m.from === cfg.peer && (!senderSession || !cfg.session || senderSession === cfg.session)) continue;
      const wantTo = topic === inbox ? cfg.peer : "all";
      if (m.to !== wantTo || (m.toSession !== undefined && m.toSession !== cfg.session)) continue;
      // A start-only post (only @harness:model tags) addresses the sessions its tags start; no running session takes it.
      if (topic === all && m.from === "operator" && m.startOnly === true && m.toSession === undefined) continue;
      // An agent session does not take project-chat noise. The cursor has already moved past it, so it never starts a turn.
      // A direct message was accepted above. An operator post that @mentions this session or its harness is kept.
      if (topic === all && cfg.session && !mentionsAgent(m.body, cfg)) continue;
      const operatorThread = m.from === "operator" && m.operatorThread === true && Boolean(m.toSession);
      const operatorBroadcast = m.from === "operator" && topic === all;
      // A screenshot travels as an attachment; local_path appears once this machine has the file cached.
      const attachment = attachmentOf(ev);
      const message = queuedMessage({
        id: ev.id,
        from: addressOf(m.from as string, senderSession),
        to: m.toSession ? `${m.to}#${m.toSession}` : m.to,
        ts: timestampOf(m),
        body: m.body.slice(0, MAX_BODY_CHARS),
        ...(operatorThread ? { operatorThread: true } : {}),
        ...(operatorBroadcast ? { operatorBroadcast: true } : {}),
        ...(m.from === "operator" && m.system === true ? { system: true } : {}),
        ...(typeof m.replyTo === "string" && MESSAGE_ID.test(m.replyTo) ? { replyTo: m.replyTo } : {}),
        ...(RESPOND_STATES.includes(m.state as string) ? { state: m.state } : {}),
        ...(m.urgent === true ? { urgent: true } : {}),
        ...(m.priority === "fyi" ? { priority: "fyi" } : {}),
        ...(m.expectReply === true ? { expectReply: true } : {}),
        ...(m.from === "operator" && isGithubLogin(m.by) ? { by: m.by } : {}),
        ...(m.from === "operator" && typeof m.mentionedIn === "string" && MENTIONED_IN.test(m.mentionedIn) ? { mentionedIn: m.mentionedIn } : {}),
        ...(m.from === "operator" && typeof m.forSubagent === "string" && SUBAGENT_RUN.test(m.forSubagent) ? { forSubagent: m.forSubagent } : {}),
        ...(m.from === "operator" && typeof m.forTeam === "string" && TEAM_NAME.test(m.forTeam) ? { forTeam: m.forTeam } : {}),
        // A screenshot travels as an attachment; local_path appears once this machine has the file cached.
        ...(attachment ? { attachment: localizedAttachment(cfg, attachment) } : {}),
      }, state);
      if (message) add(message);
    }
  }
  if (strict && lastError && out.length === 0) throw lastError as Error;
  state.seen = [...seen].slice(-SEEN_MAX);
  return out;
}

/**
 * Newest `limit` msg envelopes on the project's all topic, oldest first. Read-only: no cursor, no receipts.
 */
export async function channelHistory(cfg: Cfg, { limit = HISTORY_DEFAULT }: { limit?: number } = {}): Promise<InboxMessage[]> {
  if (!cfg.enabled) throw new Error(`disabled: ${cfg.reason}`);
  const events = await pollCached(cfg, broadcastTopic(cfg.project), "all", undefined, { tailBytes: HISTORY_TAIL_BYTES });
  const out: InboxMessage[] = [];
  for (const ev of events) {
    const m = parseEnvelope(ev.message);
    if (m?.kind !== "msg" || typeof m.body !== "string" || m.to !== "all" || m.toSession !== undefined || !isValidName(m.from)) continue;
    // An image in history names its cached copy when this machine has one, so a reader never re-downloads it.
    const attachment = attachmentOf(ev);
    out.push({
      id: ev.id,
      from: addressOf(m.from as string, sessionOf(m)),
      to: "all",
      ts: timestampOf(m),
      body: m.body.slice(0, MAX_BODY_CHARS),
      ...(m.from === "operator" && isGithubLogin(m.by) ? { by: m.by } : {}),
      ...(attachment ? { attachment: localizedAttachment(cfg, attachment) } : {}),
    });
  }
  return out.slice(-Math.min(Math.max(Math.trunc(Number(limit)) || HISTORY_DEFAULT, 1), HISTORY_MAX));
}

// Ids reserved by a pusher that have not expired yet.
function liveReserved(state: InboxState, now: number): string[] {
  return Object.keys(state.reserved).filter((id) => untilOf(state.reserved[id]) > now);
}

// A reservation is a number (an expiry, the dispatcher's) or {until, owner} (a workflow's).
function untilOf(v: unknown): number {
  return typeof v === "number" ? v : ((v as { until?: number } | null | undefined)?.until ?? 0);
}

function ownerOf(v: unknown): string | null {
  return typeof v === "object" && v ? ((v as { owner?: string }).owner ?? null) : null;
}

// Runs fn under the file lock; fn runs synchronously inside it, as before the typed move.
function underLock<T>(file: string, fn: () => T, options?: { waitMs?: number }) {
  return withLock(file, async () => fn(), options);
}

// Runs fn under the inbox lock, retrying once with a longer wait; { locked: false } when both attempts fail.
async function withInboxLock<T>(file: string, fn: () => T) {
  const first = await underLock(file, fn);
  return first.locked ? first : underLock(file, fn, { waitMs: 5000 });
}

/**
 * Reserves messages for one delivery path under the inbox lock, so the waiter's claim and the dispatcher's push cannot
 * both take one. Returns the ids this caller owns; [] when the lock is busy. allowSeen reserves ids already delivered
 * (a redelivery), so the seen list can be trimmed without exposing them.
 */
export async function reserveDelivery(cfg: Cfg, ids: string[], { now = Date.now(), ttlMs = RESERVE_MS, allowSeen = false }: { now?: number; ttlMs?: number; allowSeen?: boolean } = {}): Promise<string[]> {
  const file = statePath(cfg);
  const r = await withInboxLock(file, () => {
    const state = readState(file) as InboxState;
    const taken = new Set([...(allowSeen ? [] : state.seen), ...liveReserved(state, now)]);
    const own = ids.filter((id) => !taken.has(id) && !state.queue?.[id]?.cancelled);
    for (const id of own) state.reserved[id] = now + ttlMs;
    writeState(file, state);
    return own;
  });
  return r.locked ? r.value : [];
}

/** Drops reservations after a failed push or an expired confirmation, so the waiter and the hooks can take the messages. */
export async function releaseDelivery(cfg: Cfg, ids: string[]): Promise<void> {
  const file = statePath(cfg);
  await withInboxLock(file, () => {
    const state = readState(file) as InboxState;
    for (const id of ids) delete state.reserved[id];
    writeState(file, state);
  });
}

/** Marks messages as delivered by another path (the dispatcher), so this session's hooks skip them. */
export async function markDelivered(cfg: Cfg, ids: string[]): Promise<void> {
  const file = statePath(cfg);
  await withInboxLock(file, () => {
    const state = readState(file) as InboxState;
    state.seen = [...new Set([...state.seen, ...ids])].slice(-SEEN_MAX);
    for (const id of ids) delete state.reserved[id];
    writeState(file, state);
  });
}

/** Latest status per peer seen in the last `since` window (a bus duration like "12h"). */
export async function readStatuses(cfg: Cfg, { since = "24h" }: { since?: string } = {}) {
  return latestStatuses(await pollCached(cfg, statusTopic(cfg.project), since));
}

/** Latest status per peer or peer#session in a list of status-topic events, oldest first. */
export function latestStatuses(events: TransportEvent[], latest = new Map<string, { event: string; harness: string; ts: string; parent?: string }>()) {
  for (const ev of events) {
    const m = parseEnvelope(ev.message);
    if (!m || m.kind !== "status" || !isValidName(m.from)) continue;
    latest.set(addressOf(m.from as string, sessionOf(m)), {
      event: String(m.event || "").slice(0, 10),
      harness: String(m.harness || "").slice(0, 10),
      ts: String(m.ts || "").slice(0, 40),
      ...(typeof m.parent === "string" && /^[a-z0-9-]{1,24}#[a-f0-9]{16}$/.test(m.parent) ? { parent: m.parent } : {}),
    });
  }
  return latest;
}

/**
 * Reserves messages for one workflow owner (its workflow id). The owner re-acquires its own reservations, so a restart
 * resumes them. Resolves {owned, busy}: owned are the ids this owner holds; busy is true when the inbox lock stayed taken.
 */
export async function reserveOwned(cfg: Cfg, ids: string[], { owner, now = Date.now(), ttlMs = RESERVE_MS, allowSeen = false }: { owner: string; now?: number; ttlMs?: number; allowSeen?: boolean }): Promise<{ owned: string[]; busy: boolean }> {
  const file = statePath(cfg);
  const r = await withInboxLock(file, () => {
    const state = readState(file) as InboxState;
    const seen = new Set(allowSeen ? [] : state.seen);
    const own = ids.filter((id) => !seen.has(id) && !state.queue?.[id]?.cancelled && (untilOf(state.reserved[id]) <= now || ownerOf(state.reserved[id]) === owner));
    for (const id of own) state.reserved[id] = { until: now + ttlMs, owner };
    writeState(file, state);
    return own;
  });
  return r.locked ? { owned: r.value, busy: false } : { owned: [], busy: true };
}

/** Drops this owner's reservations after a failed push or an expired confirmation; another owner's stay. */
export async function releaseOwned(cfg: Cfg, ids: string[], owner: string): Promise<void> {
  const file = statePath(cfg);
  await withInboxLock(file, () => {
    const state = readState(file) as InboxState;
    for (const id of ids) if (ownerOf(state.reserved[id]) === owner) delete state.reserved[id];
    writeState(file, state);
  });
}
