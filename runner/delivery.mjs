// Delivery workflow: one durable workflow per (session, message). It reserves, pushes, confirms and marks the message,
// then redelivers an expect-reply message until it is answered. Steps and sleeps are checkpointed in runner.db.
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, MAX_ATTEMPTS, REDELIVER_MS, TTL_MS } from "../lib/deliver-push.mjs";

export const DELIVERY = "delivery";
export const READY_POLL_MS = 5000;

/** Durable wait after the nth failed push: BACKOFF_BASE_MS doubling, capped at BACKOFF_MAX_MS. */
export function backoffMs(failures) {
  return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
}

/**
 * Builds the workflow function over deps (injectable; the live set is in runner/runner.mjs):
 *   now(); scfgOf(project, session); sessionOf(project, address) -> live session or null; ready(session) -> bool; busy?(session) -> bool (still working on an earlier push);
 *   reserve(scfg, ids, {owner, allowSeen}) -> {owned, busy}; release(scfg, ids, owner); markDelivered(scfg, ids);
 *   snapshot(session) -> JSON; push(session, {text, urgent, ids}) -> {status}; awaitConfirm(id, session, snapshot) -> bool;
 *   waitConfirmed(session, ids, snapshot) -> bool after the full confirm window; confirmedSince(session, ids, snapshot) -> bool;
 *   acked(project, address, message) -> bool; textFor(scfg, message, attempt) -> string.
 * Optional overrides for tests: backoffMs(failures), redeliverMs, readyPollMs.
 * Input: {project, address, message, redeliver?: {pushes, firstAt}} (redeliver resumes a message the dispatcher delivered).
 * Output: {status} with status delivered, skipped, cut, answered, dropped or expired.
 */
export function deliveryWorkflow(deps) {
  const backoff = deps.backoffMs ?? backoffMs;
  const redeliverMs = deps.redeliverMs ?? REDELIVER_MS;
  const readyPollMs = deps.readyPollMs ?? READY_POLL_MS;
  return async function delivery(wf, input) {
    const { project, address, message, redeliver = null } = input;
    const id = message.id;
    const owner = wf.id;
    const firstAt = await wf.step("start", () => redeliver?.firstAt ?? deps.now());
    const expired = () => deps.now() - firstAt >= TTL_MS;
    // The first snapshot of the workflow: every resend is checked against it, so a landed push is never sent twice.
    let snap;

    // Waits, without a checkpoint, until the target is live and ready; resolves null once the TTL passes.
    // A redelivery also waits while the target works on an earlier push, so busy sessions do not queue stale copies.
    async function target(redelivery) {
      for (;;) {
        if (expired()) return null;
        const session = deps.sessionOf(project, address);
        if (session && await deps.ready(session) && !(redelivery && await deps.busy?.(session))) return session;
        await wf.pause(readyPollMs);
      }
    }

    // One push attempt. Resolves "delivered", "failed" (retry after backoff), "cut" (never sent again), "skipped" or "expired".
    async function attempt(attemptNo, { allowSeen }) {
      const session = await target(attemptNo > 1);
      if (!session) return "expired";
      const scfg = deps.scfgOf(project, session);
      if (snap === undefined) snap = await wf.step("snapshot", () => deps.snapshot(session));
      if (attemptNo > 1 && await wf.step("recheck", () => deps.confirmedSince(session, [id], snap))) {
        await wf.step("mark", () => deps.markDelivered(scfg, [id]));
        return "delivered";
      }
      const got = await wf.step("reserve", () => deps.reserve(scfg, [id], { owner, allowSeen }));
      if (got.busy) return "failed";
      if (!got.owned.length) return "skipped";
      const current = deps.reservedMessage ? deps.reservedMessage(scfg, message) : message;
      if (!current) return "skipped";
      const text = await Promise.resolve().then(() => deps.textFor(scfg, current, attemptNo));
      const pushed = await wf.step("push", () => deps.push(session, { text, urgent: current.urgent === true, ids: [id] }), {
        onCut: async () => ({ status: await deps.waitConfirmed(session, [id], snap) ? "delivered" : "cut" }),
      });
      if (pushed.status === "delivered") {
        await wf.step("mark", () => deps.markDelivered(scfg, [id]));
        return "delivered";
      }
      if (pushed.status === "cut" || pushed.status === "unsent") {
        await wf.step("release", () => deps.release(scfg, [id], owner));
        return pushed.status === "cut" ? "cut" : "failed";
      }
      // Unconfirmed: renew the reservation for the watch, then wait for the write to show in the transcript.
      await wf.step("renew", () => deps.reserve(scfg, [id], { owner, allowSeen: true }));
      const c = await wf.step("confirm", () => deps.awaitConfirm(id, session, snap).then((confirmed) => ({ confirmed, cut: false })), {
        onCut: async () => ({ confirmed: await deps.waitConfirmed(session, [id], snap), cut: true }),
      });
      if (c.confirmed) {
        await wf.step("mark", () => deps.markDelivered(scfg, [id]));
        return "delivered";
      }
      if (c.cut) {
        await wf.step("release", () => deps.release(scfg, [id], owner));
        return "cut";
      }
      if (await wf.step("late", () => deps.confirmedSince(session, [id], snap))) {
        await wf.step("mark", () => deps.markDelivered(scfg, [id]));
        return "delivered";
      }
      await wf.step("release", () => deps.release(scfg, [id], owner));
      return "failed";
    }

    // Attempts until delivered, skipped, cut or past the TTL; a failed attempt waits a durable backoff first.
    async function deliver(attemptNo, opts) {
      for (let failures = 0; ; ) {
        const outcome = await attempt(attemptNo, opts);
        if (outcome !== "failed") return outcome;
        failures += 1;
        await wf.sleep(backoff(failures));
      }
    }

    let pushes = redeliver?.pushes ?? 0;
    if (!redeliver) {
      const first = await deliver(1, { allowSeen: false });
      if (first !== "delivered") return { status: first };
      if (message.expectReply !== true) return { status: "delivered", pushes: 1 };
      pushes = 1;
    }

    // Redelivery: after each redeliverMs without an answer, push again, at most MAX_ATTEMPTS pushes in all.
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
