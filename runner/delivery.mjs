// Delivery workflow: one durable workflow per (session, message id). It reserves, pushes, confirms and marks the message,
// then redelivers an expect-reply message until it is answered. Steps and sleeps are checkpointed in runner.db.
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, MAX_ATTEMPTS, REDELIVER_MS, TTL_MS } from "../lib/deliver-push.mjs";

export const DELIVERY = "delivery";
export const READY_POLL_MS = 5000;

/** Durable wait after the nth failed push: BACKOFF_BASE_MS doubling, capped at BACKOFF_MAX_MS. */
export function backoffMs(failures) {
  return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
}

/**
 * Builds the workflow function over deps (all injectable; see runner/runner.mjs for the live set):
 *   now() -> ms; scfgOf(project, session) -> config for the session; sessionOf(project, address) -> live session or null;
 *   ready(session) -> bool; reserve(scfg, ids, {allowSeen}) -> owned ids; release(scfg, ids); markDelivered(scfg, ids);
 *   snapshot(session) -> JSON; push(session, {text, urgent, ids}) -> {status}; awaitConfirm(id, session, snapshot) -> bool;
 *   backoffMs(failures), redeliverMs and readyPollMs override the defaults in tests;
 *   confirmedSince(session, ids, snapshot) -> bool; acked(project, address, message) -> bool; textFor(scfg, message, attempt) -> string.
 * Input: {project, address, message}. Output: {status} with status delivered, skipped, cut, answered, dropped or expired.
 */
export function deliveryWorkflow(deps) {
  const backoff = deps.backoffMs ?? backoffMs;
  const redeliverMs = deps.redeliverMs ?? REDELIVER_MS;
  const readyPollMs = deps.readyPollMs ?? READY_POLL_MS;
  return async function delivery(wf, input) {
    const { project, address, message } = input;
    const id = message.id;
    const firstAt = await wf.step("start", () => deps.now());
    const expired = () => deps.now() - firstAt >= TTL_MS;

    // Waits, without a checkpoint, until the target is live and ready; resolves null once the TTL passes.
    async function target() {
      for (;;) {
        if (expired()) return null;
        const session = deps.sessionOf(project, address);
        if (session && await deps.ready(session)) return session;
        await wf.pause(readyPollMs);
      }
    }

    // One push attempt. Resolves "delivered", "failed" (retry after backoff), "cut" or "skipped" (reserved elsewhere).
    async function attempt(session, attemptNo, { allowSeen }) {
      const scfg = deps.scfgOf(project, session);
      const text = deps.textFor(scfg, message, attemptNo);
      const owned = await wf.step("reserve", () => deps.reserve(scfg, [id], { allowSeen }));
      if (!owned.length) return "skipped";
      const snap = await wf.step("snapshot", () => deps.snapshot(session));
      // A cut push is checked before anything else: a landed push counts as delivered and is never sent again.
      const pushed = await wf.step("push", () => deps.push(session, { text, urgent: message.urgent === true, ids: [id] }), {
        onCut: async () => ({ status: await deps.confirmedSince(session, [id], snap) ? "delivered" : "cut" }),
      });
      if (pushed.status === "delivered") {
        await wf.step("mark", () => deps.markDelivered(scfg, [id]));
        return "delivered";
      }
      if (pushed.status === "cut") {
        await wf.step("cut", () => deps.markDelivered(scfg, [id]));
        return "cut";
      }
      if (pushed.status === "unsent") {
        await wf.step("release", () => deps.release(scfg, [id]));
        return "failed";
      }
      // Unconfirmed: the transcript has not shown the write yet. A late confirmation settles it before any resend.
      const confirmed = await wf.step("confirm", () => deps.awaitConfirm(id, session, snap), {
        onCut: () => deps.confirmedSince(session, [id], snap),
      });
      if (confirmed || await wf.step("late", () => deps.confirmedSince(session, [id], snap))) {
        await wf.step("mark", () => deps.markDelivered(scfg, [id]));
        return "delivered";
      }
      await wf.step("release", () => deps.release(scfg, [id]));
      return "failed";
    }

    // Pushes until delivered, skipped, cut or past the TTL; a failed attempt waits a durable backoff first.
    async function deliver(attemptNo, opts) {
      for (let failures = 0; ; ) {
        const session = await target();
        if (!session) return "expired";
        const outcome = await attempt(session, attemptNo, opts);
        if (outcome !== "failed") return outcome;
        failures += 1;
        await wf.sleep(backoff(failures));
      }
    }

    const first = await deliver(1, { allowSeen: false });
    if (first !== "delivered") return { status: first };
    if (message.expectReply !== true) return { status: "delivered", pushes: 1 };

    // Redelivery: after each REDELIVER_MS without an answer, push again, at most MAX_ATTEMPTS pushes in all.
    let pushes = 1;
    for (;;) {
      await wf.sleep(redeliverMs);
      if (await wf.step("acked", () => deps.acked(project, address, message))) return { status: "answered", pushes };
      if (expired()) return { status: "expired", pushes };
      if (pushes >= MAX_ATTEMPTS) return { status: "dropped", pushes };
      const outcome = await deliver(pushes + 1, { allowSeen: true });
      if (outcome === "expired" || outcome === "cut") return { status: outcome, pushes };
      if (outcome === "delivered") pushes += 1;
    }
  };
}
