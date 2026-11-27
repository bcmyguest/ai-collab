/**
 * Claude asyncRewake waiter: streams this session's inbox and broadcast topics (stop.mjs streamWaiter) while the
 * session is idle. When a non-fyi message arrives it claims the inbox and returns it; the hook script then exits 2,
 * which wakes the idle session. While the session's Stop hook runs (an AFK or question hold), the waiter claims nothing:
 * Claude queues a rewake until that hook ends, so the hold delivers the message instead. One waiter per session: a pid file in the session state dir; a new waiter kills the old one.
 */
import { readFileSync, rmSync } from "node:fs";
import { claimInbox } from "./messaging.ts";
import { formatInbox } from "./format.mjs";
import { isRunning, processStart } from "./process.mjs";
import { readInbox, streamWaiter, waitUntil } from "./messaging.ts";
import type { Cfg, InboxMessage, Outcome, Step } from "./messaging.ts";
import { statePath, withLock, writeState } from "./state.mjs";
import { stopHookRunning } from "./stop.mjs";
import { setTimeout as delay } from "node:timers/promises";

// Below the 3600 s hook timeout in hooks/hooks.json; the next hook event re-arms a waiter that ran out.
export const WAITER_MAX_S = 3300;
const SLICE_MS = 30_000;
const HELD_POLL_MS = 500;
// Time a Stop-started waiter gives the Stop hook to mark itself (lib/stop.mjs stopHookRunning).
export const STOP_GRACE_MS = 1500;

type Slot = { pid: number; start: string };

function slotFile(cfg: Cfg): string {
  return statePath(cfg).replace(/\.json$/, ".waiter.json");
}

function readSlot(file: string): Slot | null {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    return Number.isInteger(s.pid) && typeof s.start === "string" ? s : null;
  } catch {
    return null;
  }
}

/** Takes the session's single waiter slot: stops the previous waiter, records this process. Returns the release function. */
export async function takeWaiterSlot(cfg: Cfg, { pid = process.pid, kill = process.kill.bind(process) }: { pid?: number; kill?: (pid: number, signal: NodeJS.Signals) => void } = {}): Promise<() => void> {
  const file = slotFile(cfg);
  await withLock(file, async () => {
    const old = readSlot(file);
    if (old && old.pid !== pid && isRunning({ pid: old.pid, start: old.start })) {
      try { kill(old.pid, "SIGTERM"); } catch { /* already gone */ }
    }
    writeState(file, { pid, start: processStart(pid) || "" });
  });
  return () => {
    if (readSlot(file)?.pid === pid) rmSync(file, { force: true });
  };
}

// Resolves "event" once held() turns false, "timeout" after ms, "aborted" on the signal.
async function released(held: () => boolean, ms: number, signal?: AbortSignal): Promise<Outcome> {
  const end = Date.now() + ms;
  while (held()) {
    if (signal?.aborted) return "aborted";
    const left = end - Date.now();
    if (left <= 0) return "timeout";
    await delay(Math.min(HELD_POLL_MS, left), undefined, { signal }).catch(() => {});
  }
  return signal?.aborted ? "aborted" : "event";
}

function wakeText(cfg: Cfg, messages: InboxMessage[]): string {
  return [
    formatInbox(messages, { session: cfg.session, peer: cfg.peer }),
    "[ai-collab] These messages arrived while this session was idle. Answer the operator as instructed above.",
  ].filter(Boolean).join("\n");
}

/**
 * Waits for a wake-worthy message until maxMs. Resolves {code: 2, text} with claimed messages, or {code: 0}
 * on timeout, abort or when alive() turns false. A message with priority fyi never wakes the session.
 */
export async function runWaiter(cfg: Cfg, {
  maxMs = WAITER_MAX_S * 1000, wait, claim = claimInbox, alive = () => true, now = Date.now, signal,
  held = () => stopHookRunning(cfg), graceMs = 0,
}: {
  maxMs?: number; wait?: Step; claim?: typeof claimInbox; alive?: () => boolean; now?: () => number; signal?: AbortSignal;
  held?: () => boolean; graceMs?: number;
} = {}): Promise<{ code: 0 } | { code: 2; text: string }> {
  const waitFor = wait ?? streamWaiter(cfg, now());
  const deadline = now() + maxMs;
  // A waiter started with the Stop hook lets that hook mark itself first, so a message waiting at Stop goes to the hold.
  if (graceMs > 0) await delay(Math.min(graceMs, maxMs), undefined, { signal }).catch(() => {});
  const r = await waitUntil({
    deadline,
    signal,
    now,
    alive,
    // While the Stop hook runs, it delivers; the waiter watches only for the hook's end, then catches up on the stream.
    stream: (ms, sig) => (held() ? released(held, Math.min(ms, SLICE_MS), sig) : waitFor(Math.min(ms, SLICE_MS), sig)),
    until: async () => {
      if (held()) return undefined;
      const waiting = await readInbox(cfg, { peek: true, strict: false, accept: (m) => m.priority !== "fyi", claim }).catch(() => []);
      if (!waiting.length) return undefined;
      const messages = await readInbox(cfg, { limit: 4, strict: false, claim }).catch(() => []);
      return messages.length ? messages : undefined;
    },
  });
  return r.status === "hit" ? { code: 2, text: wakeText(cfg, r.value) } : { code: 0 };
}
