// Delivery workflow: one durable workflow per (session, message). It reserves, pushes, confirms and marks the message,
// then redelivers an expect-reply message until it is answered. Steps and sleeps are checkpointed in runner.db.
import { backoffMs, nextAction, REDELIVER_MS } from "../lib/delivery.ts";

export const DELIVERY = "delivery";
export const READY_POLL_MS = 5000;

/**
 * Builds the workflow function over deps (injectable; the live set is in runner/runner.mjs):
 *   now(); scfgOf(project, session); sessionOf(project, address) -> live session or null; probe?(session) -> live-set probe, once per poll;
 *   ready(session, probe) -> bool; busy?(session, probe) -> bool (still working on an earlier push);
 *   reserve(scfg, ids, {owner, allowSeen}) -> {owned, busy}; release(scfg, ids, owner); markDelivered(scfg, ids);
 *   snapshot(session) -> JSON; push(session, {text, urgent, ids}) -> {status}; awaitConfirm(id, session, snapshot) -> bool;
 *   waitConfirmed(session, ids, snapshot) -> bool after the full confirm window; confirmedSince(session, ids, snapshot) -> bool;
 *   acked(project, address, message) -> bool; textFor(scfg, message, attempt) -> string.
 * Optional overrides for tests: backoffMs(failures), redeliverMs, readyPollMs.
 * Input: {project, address, message, redeliver?: {pushes, firstAt}} (redeliver resumes a message the dispatcher delivered).
 * Output: {status} with status delivered, skipped, cut, answered, dropped or expired.
 * The timing and attempt rules come from lib/delivery.ts nextAction.
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
    // The first snapshot of the workflow: every resend is checked against it, so a landed push is never sent twice.
    let snap;
    // Ms of the last redelivery wake; the next redelivery is due no earlier than this.
    let dueAt = null;
    const stateOf = (attemptNo) => ({ firstAt, pushes: attemptNo - 1, dueAt });

    // Waits, without a checkpoint, until nextAction allows a push: resolves the live session, or the action that ends the message.
    async function target(state) {
      for (;;) {
        // A replayed attempt has its outcome recorded, so it takes no live probe.
        if (wf.replaying) {
          const replayed = deps.sessionOf(project, address);
          if (replayed) return replayed;
        }
        const session = deps.sessionOf(project, address);
        // One probe per poll, shared by ready and busy.
        const active = session ? (await deps.probe?.(session)) ?? null : null;
        const ready = Boolean(session) && await deps.ready(session, active);
        const busy = ready && state.pushes > 0 && Boolean(await deps.busy?.(session, active));
        // Acks matter only to a redelivery; the first push never polls them.
        const acked = state.pushes > 0 && !wf.replaying && await deps.acked(project, address, message);
        const action = nextAction(state, deps.now(), { acked, busy, ready });
        if (action === "push") return session;
        if (action !== "wait") return action;
        await wf.pause(readyPollMs);
      }
    }

    // One push attempt. Resolves "delivered", "failed" (retry after backoff), "cut" (never sent again), "skipped", "expired", "dropped" or "answered".
    async function attempt(attemptNo, { allowSeen }) {
      const session = await target(stateOf(attemptNo));
      if (typeof session === "string") return session;
      const scfg = deps.scfgOf(project, session);
      if (snap === undefined) snap = await wf.step("snapshot", () => deps.snapshot(session));
      if (attemptNo > 1 && await wf.step("recheck", () => deps.confirmedSince(session, [id], snap))) {
        await wf.step("mark", () => deps.markDelivered(scfg, [id]));
        return "delivered";
      }
      // A redelivery re-checks the answer before reserving, so an answer seen while waiting never gets a copy.
      if (attemptNo > 1 && !wf.replaying && await deps.acked(project, address, message)) return "answered";
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
      // The durable sleep has just run out, so the redelivery is due: dueAt is the wake time.
      dueAt = deps.now();
      const acked = await wf.step("acked", () => deps.acked(project, address, message));
      // Ready and busy are decided on each poll in target(); here only the answer, TTL and attempt cap can end the message.
      const wake = nextAction(stateOf(pushes + 1), deps.now(), { acked, busy: false, ready: true });
      if (wake !== "push") return { status: wake, pushes };
      const outcome = await deliver(pushes + 1, { allowSeen: true });
      if (["answered", "expired", "cut", "dropped"].includes(outcome)) return { status: outcome, pushes };
      if (outcome === "delivered") pushes += 1;
    }
  };
}
