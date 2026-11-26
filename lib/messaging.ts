// The deadline wait loop (poll or stream), the stream waiter, and the inbox read: claim, then receipts.
import { setTimeout as delay } from "node:timers/promises";
import { broadcastTopic, inboxTopic } from "./config.mjs";
import { claimInbox } from "./inbox.mjs";
import { sendReceipts, settleReceipts } from "./receipts.mjs";
import { streamEvents } from "./transport.mjs";
import { reconnectBackoff } from "./operator.ts";

const STREAM_BACKOFF_MAX_MS = 60_000;

type Cfg = Parameters<typeof claimInbox>[0];
type Claim = typeof claimInbox;
type Message = { id: string; [key: string]: unknown };
export type Outcome = "event" | "timeout" | "error" | "aborted" | "queued";
export type Step = (ms: number, signal?: AbortSignal) => Promise<Outcome>;
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<unknown>;
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
export type ReadOptions = { peek?: boolean; strict?: boolean; limit?: number; accept?: (m: Message) => boolean; receipts?: boolean; settle?: boolean; claim?: Claim };

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
