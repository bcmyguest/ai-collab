// Operator phone replies: matching, the reply wait (stream or poll), the approval-end envelope, and the wait limit.
import { setTimeout as delay } from "node:timers/promises";
import { encodeEnvelope, parseWireEnvelope } from "./agui.mjs";
import { parseMode } from "./mode.mjs";
import { pollCached, streamEvents, type Cfg } from "./messaging.ts";

export const WAIT_MAX_S = 45;
const RETRY_MAX_MS = 30_000;
const REPLY = /^reply ([a-f0-9]{12}) ([\s\S]+)$/;
const MAX_ANSWER_CHARS = 2000;
const SINCE_DEFAULT = "12h";

export type Envelope = { id: string; message: string };
export type ChoiceQuestion = { question: string; multiSelect?: boolean; options: { label: string }[] };
export type Labels = Record<string, string[]>;
export type Reply = { id: string; answer: string; messageId: string; labels?: Labels };
export type Match = { skipped: true; id: string } | ({ skipped: false } & Reply);
export type OperatorConfig = Cfg;
export type StreamFn = (cfg: OperatorConfig, topics: string[], opts: { since: string; signal?: AbortSignal; onOpen?: () => void }) => AsyncIterable<Envelope>;
export type PollFn = (cfg: OperatorConfig, topic: string, since: string, signal?: AbortSignal) => Promise<Envelope[]>;
export type WaitOutcome<T> = { status: "reply"; value: T; messageId: string } | { status: "skipped" } | { status: "afk-off" } | { status: "timeout" } | { status: "cancelled" };
export type EndExtra = { session?: string; owned?: boolean };
export type WaitOptions<T> = {
  cfg: OperatorConfig; topic: string; id: string; deadline: number; signal?: AbortSignal; mode: "stream" | "poll"; since?: string;
  questions?: ChoiceQuestion[]; read: (reply: Reply) => T | null;
  afterMode?: number; intervalMs?: number; stream?: StreamFn; poll?: PollFn;
};

/** A phone reply as {id, answer}, or null when the text is not a reply with a non-blank answer. */
export function parsePhoneReply(message: string): { id: string; answer: string } | null {
  const match = REPLY.exec(message);
  if (!match || !match[2].trim()) return null;
  return { id: match[1], answer: match[2].trim().slice(0, MAX_ANSWER_CHARS) };
}

/** The question ID an operator Skip closes, or null. */
export function skippedQuestionId(message: string): string | null {
  let e;
  try { e = parseWireEnvelope(message); } catch { return null; }
  return e?.kind === "approval-end" && e.reason === "skipped" && e.from === "operator" ? e.id : null;
}

// One option label matched case-insensitively, else the text itself (the "Other" answer).
function matchLabel(question: ChoiceQuestion, value: string): string {
  const found = question.options.find((o) => o.label.toLowerCase() === value.trim().toLowerCase());
  return found ? found.label : value.trim();
}

/** Chosen labels per question from a reply: JSON {question: answer}, or plain text for a single question; null when incomplete. */
export function choiceLabels(questions: ChoiceQuestion[], answer: string): Labels | null {
  let map: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(answer);
    if (value && typeof value === "object" && !Array.isArray(value)) map = value;
  } catch { /* plain text */ }
  if (!map) {
    if (questions.length !== 1) return null;
    map = { [questions[0].question]: answer };
  }
  const labels: Labels = {};
  for (const q of questions) {
    const value = map[q.question];
    if (typeof value !== "string" || !value.trim()) return null;
    const parts = q.multiSelect ? value.split(",").filter((part) => part.trim()) : [value];
    labels[q.question] = parts.map((part) => matchLabel(q, part));
  }
  return labels;
}

/** Answers for a choice from a reply: {question: "label, label"}, or null when incomplete. */
export function parseChoice(questions: ChoiceQuestion[], answer: string): Record<string, string> | null {
  const labels = choiceLabels(questions, answer);
  return labels && Object.fromEntries(Object.entries(labels).map(([question, parts]) => [question, parts.join(", ")]));
}

/** The one reply parser: a skip of id, or a reply to id (a choice reply must name valid labels); null for anything else. */
export function matchReply(event: Envelope, { id, questions }: { id: string; questions?: ChoiceQuestion[] }): Match | null {
  if (skippedQuestionId(event.message) === id) return { skipped: true, id };
  const reply = parsePhoneReply(event.message);
  if (!reply || reply.id !== id) return null;
  const labels = questions ? choiceLabels(questions, reply.answer) : undefined;
  if (questions && !labels) return null;
  return { skipped: false, id, answer: reply.answer, messageId: event.id, ...(labels ? { labels } : {}) };
}

/** Throws unless seconds is an integer from 0 to WAIT_MAX_S. */
export function assertWaitSeconds(seconds: unknown): void {
  if (!Number.isInteger(seconds) || (seconds as number) < 0 || (seconds as number) > WAIT_MAX_S) {
    throw new Error(`Wait must be an integer from 0 to ${WAIT_MAX_S} seconds`);
  }
}

/** Backoff for stream reconnects: starts at baseMs, doubles per failed wait up to maxMs, and resets when a stream opens. */
export function reconnectBackoff(baseMs: number, maxMs = RETRY_MAX_MS) {
  let ms = baseMs;
  return {
    reset() { ms = baseMs; },
    async wait(signal?: AbortSignal, capMs = Infinity): Promise<void> {
      await delay(Math.min(ms, capMs), undefined, { signal }).catch(() => {});
      ms = Math.min(ms * 2, maxMs);
    },
  };
}

/** The approval-end envelope that closes a card; session and owned appear only when given. */
export function approvalEnd(cfg: { peer: string; wire: string }, id: string, reason: string, extra: EndExtra = {}): string {
  const { session, owned } = extra;
  return encodeEnvelope("approval-end", {
    from: cfg.peer, ...(session !== undefined ? { session } : {}), id, reason, ...(owned ? { owned: true } : {}), ts: new Date().toISOString(),
  }, cfg.wire);
}

// Matches one event against the wait; null keeps waiting (no match, or read rejected the reply).
function scanEvent<T>(event: Envelope, o: WaitOptions<T>): WaitOutcome<T> | null {
  const match = matchReply(event, { id: o.id, questions: o.questions });
  if (!match) return null;
  if (match.skipped) return { status: "skipped" };
  const value = o.read(match);
  return value === null ? null : { status: "reply", value, messageId: event.id };
}

// Streams the topic; a failed or ended stream reconnects after backoff, resuming from the last event id.
async function streamWait<T>(o: WaitOptions<T>): Promise<WaitOutcome<T>> {
  const stream = o.stream ?? streamEvents;
  const ctrl = new AbortController();
  let reason: "timeout" | "cancelled" = "timeout";
  const stop = (why: "timeout" | "cancelled") => { if (!ctrl.signal.aborted) { reason = why; ctrl.abort(); } };
  const timer = setTimeout(() => stop("timeout"), Math.max(0, o.deadline - Date.now()));
  const onAbort = () => stop("cancelled");
  o.signal?.addEventListener("abort", onAbort, { once: true });
  if (o.signal?.aborted) stop("cancelled");
  const backoff = reconnectBackoff(o.cfg.stopPollMs);
  let since = o.since ?? "";
  try {
    while (!ctrl.signal.aborted) {
      try {
        for await (const event of stream(o.cfg, [o.topic], { since, signal: ctrl.signal, onOpen: () => backoff.reset() })) {
          since = event.id;
          if (o.afterMode !== undefined) {
            const mode = parseMode(event.message);
            if (mode?.mode === "off" && mode.ts > o.afterMode) return { status: "afk-off" };
          }
          const outcome = scanEvent(event, o);
          if (outcome) return outcome;
        }
      } catch { /* outage, idle timeout, or abort */ }
      if (ctrl.signal.aborted) break;
      await backoff.wait(ctrl.signal);
    }
    return { status: reason };
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
    ctrl.abort();
  }
}

// Polls the topic every intervalMs; an abort throws, and a deadline with no match returns timeout.
async function pollWait<T>(o: WaitOptions<T>): Promise<WaitOutcome<T>> {
  const poll = o.poll ?? pollCached;
  const interval = o.intervalMs ?? 4000;
  let since = o.since ?? SINCE_DEFAULT;
  while (true) {
    o.signal?.throwIfAborted();
    const events = await poll(o.cfg, o.topic, since, o.signal);
    since = events.at(-1)?.id ?? since;
    for (const event of events) {
      const outcome = scanEvent(event, o);
      if (outcome) return outcome;
    }
    const remaining = o.deadline - Date.now();
    if (remaining <= 0) return { status: "timeout" };
    await delay(Math.min(interval, remaining), undefined, { signal: o.signal });
  }
}

/** Waits for the operator's reply, skip or afk-off on the topic until the deadline. Stream mode reconnects; poll mode throws on abort. */
export function waitForOperatorReply<T>(o: WaitOptions<T>): Promise<WaitOutcome<T>> {
  return o.mode === "stream" ? streamWait(o) : pollWait(o);
}
