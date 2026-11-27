/**
 * Push delivery policy: the rules the runner's durable workflow (runner/delivery.ts) and the UI dispatcher
 * (web/server/dispatch.ts) both follow. Pure: each engine keeps its own I/O, persistence and timers.
 */
export const REDELIVER_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
export const TTL_MS = 24 * 3_600_000;
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 10 * 60_000;

export type DeliveryAction = "push" | "wait" | "answered" | "expired" | "dropped";

/** pushes: successful pushes so far; firstAt: start ms, null when the engine keeps none (no TTL); dueAt: earliest redelivery ms, null before the first push. */
export type DeliveryState = { firstAt: number | null; pushes: number; dueAt: number | null };

/** acked: the target read or answered the message; busy: it works on an earlier push; ready: it takes a push now. */
export type DeliveryFacts = { acked: boolean; busy: boolean; ready: boolean };

/** Wait after the nth failed push: BACKOFF_BASE_MS doubling, capped at BACKOFF_MAX_MS. */
export function backoffMs(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
}

/** The next step for one message, checked in this order: answer, TTL, redelivery timing, attempt cap, busy, ready. */
export function nextAction(state: DeliveryState, now: number, facts: DeliveryFacts): DeliveryAction {
  const redelivery = state.pushes > 0;
  if (redelivery && facts.acked) return "answered";
  if (state.firstAt !== null && now - state.firstAt >= TTL_MS) return "expired";
  if (redelivery && state.dueAt !== null && now < state.dueAt) return "wait";
  if (redelivery && state.pushes >= MAX_ATTEMPTS) return "dropped";
  if (redelivery && facts.busy) return "wait";
  return facts.ready ? "push" : "wait";
}
