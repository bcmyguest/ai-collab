// Delivery workflow: one durable workflow per (session, message). It reserves, pushes, confirms and marks the message,
// then redelivers an expect-reply message until it is answered. Steps and sleeps are checkpointed in runner.db.
import { backoffMs, nextAction, REDELIVER_MS, type DeliveryAction, type DeliveryState } from "../lib/delivery.ts";
import type { ClaudeSnapshot } from "../lib/claude-socket.ts";

export const DELIVERY = "delivery";
export const READY_POLL_MS = 5000;

/** A live session record or session config, passed through to deps unread. */
type Opaque = Record<string, unknown>;
type Message = { id: string; urgent?: unknown; expectReply?: unknown; [key: string]: unknown };
type PushResult = { status: string; [key: string]: unknown };
/** The live-set probe (OpenCode active session ids) and the transcript snapshot a push is confirmed against. */
type Probe = Set<string> | null;
type Snapshot = ClaudeSnapshot | null;

/** The durable workflow context deliveryWorkflow runs in (lib/durable). */
interface DeliveryWf {
  id: string;
  readonly replaying: boolean;
  step<T>(name: string, fn: () => T | Promise<T>, opts?: { onCut?: () => Promise<T> }): Promise<T>;
  pause(ms: number): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export interface DeliveryDeps {
  now(): number;
  scfgOf(project: string, session: Opaque): Opaque;
  sessionOf(project: string, address: string): Opaque | null;
  probe?(session: Opaque): Probe | Promise<Probe>;
  ready(session: Opaque, probe: Probe, project: string): boolean | Promise<boolean>;
  held?(session: Opaque, scfg: Opaque): boolean | Promise<boolean>;
  handOff?(scfg: Opaque, messages: Message[]): void | Promise<void>;
  handedOff?(scfg: Opaque, id: string): boolean;
  busy?(session: Opaque, probe: Probe): boolean | Promise<boolean>;
  reserve(scfg: Opaque, ids: string[], opts: { owner: string; allowSeen: boolean }): { owned: string[]; busy?: boolean } | Promise<{ owned: string[]; busy?: boolean }>;
  release(scfg: Opaque, ids: string[], owner: string): void | Promise<void>;
  markDelivered(scfg: Opaque, ids: string[]): void | Promise<void>;
  reservedMessage?(scfg: Opaque, message: Message): Message | null | undefined;
  snapshot(session: Opaque): Snapshot | Promise<Snapshot>;
  push(session: Opaque, opts: { text: string; urgent: boolean; ids: string[] }): PushResult | Promise<PushResult>;
  awaitConfirm(id: string, session: Opaque, snapshot: Snapshot | undefined): Promise<boolean>;
  waitConfirmed(session: Opaque, ids: string[], snapshot: Snapshot | undefined): boolean | Promise<boolean>;
  confirmedSince(session: Opaque, ids: string[], snapshot: Snapshot | undefined): boolean | Promise<boolean>;
  acked(project: string, address: string, message: Message): boolean | Promise<boolean>;
  textFor(scfg: Opaque, message: Message, attempt: number): string | Promise<string>;
  backoffMs?: (failures: number) => number;
  redeliverMs?: number;
  readyPollMs?: number;
}

export interface DeliveryInput {
  project: string;
  address: string;
  message: Message;
  redeliver?: { pushes: number; firstAt: number } | null;
}

/**
 * Builds the workflow function over deps (injectable; the live set is in runner/runner.mjs):
 *   now(); scfgOf(project, session); sessionOf(project, address) -> live session or null; probe?(session) -> live-set probe, once per poll;
 *   ready(session, probe, project) -> bool; held?(session, scfg) -> bool (a Stop hook holds the session, so the push waits);
 *   handOff?(scfg, messages) (writes the messages to the session's hand-off file for that hold, lib/stop.mjs; a handed message counts as delivered);
 *   handedOff?(scfg, id) -> bool (the hand-off file holds the id: a push cut by a restart after its hand-off);
 *   busy?(session, probe) -> bool (still working on an earlier push);
 *   reserve(scfg, ids, {owner, allowSeen}) -> {owned, busy}; release(scfg, ids, owner); markDelivered(scfg, ids);
 *   snapshot(session) -> JSON; push(session, {text, urgent, ids}) -> {status}; awaitConfirm(id, session, snapshot) -> bool;
 *   waitConfirmed(session, ids, snapshot) -> bool after the full confirm window; confirmedSince(session, ids, snapshot) -> bool;
 *   acked(project, address, message) -> bool; textFor(scfg, message, attempt) -> string.
 * Optional overrides for tests: backoffMs(failures), redeliverMs, readyPollMs.
 * Input: {project, address, message, redeliver?: {pushes, firstAt}} (redeliver resumes a message the dispatcher delivered).
 * Output: {status} with status delivered, skipped, cut, answered, dropped or expired.
 * The timing and attempt rules come from lib/delivery.ts nextAction.
 */
export function deliveryWorkflow(deps: DeliveryDeps) {
  const backoff = deps.backoffMs ?? backoffMs;
  const redeliverMs = deps.redeliverMs ?? REDELIVER_MS;
  const readyPollMs = deps.readyPollMs ?? READY_POLL_MS;
  return async function delivery(wf: DeliveryWf, input: DeliveryInput): Promise<{ status: string; pushes?: number }> {
    const { project, address, message, redeliver = null } = input;
    const id = message.id;
    const owner = wf.id;
    const firstAt = await wf.step("start", () => redeliver?.firstAt ?? deps.now());
    // The first snapshot of the workflow: every resend is checked against it, so a landed push is never sent twice.
    let snap: Snapshot | undefined;
    // Ms of the last redelivery wake; the next redelivery is due no earlier than this.
    let dueAt: number | null = null;
    const stateOf = (attemptNo: number): DeliveryState => ({ firstAt, pushes: attemptNo - 1, dueAt });

    // nextAction on live facts for session; pollAcks false skips the ack poll.
    async function actionFor(session: Opaque | null, state: DeliveryState, pollAcks: boolean): Promise<DeliveryAction> {
      // One probe per poll, shared by ready and busy.
      const active = session ? (await deps.probe?.(session)) ?? null : null;
      const ready = Boolean(session) && await deps.ready(session as Opaque, active, project);
      const busy = ready && state.pushes > 0 && Boolean(await deps.busy?.(session as Opaque, active));
      // Acks matter only to a redelivery; the first push never polls them.
      const acked = state.pushes > 0 && pollAcks && await deps.acked(project, address, message);
      return nextAction(state, deps.now(), { acked, busy, ready });
    }

    // Waits, without a checkpoint, until nextAction allows a push: resolves the live session, or the action that ends the message.
    async function target(state: DeliveryState): Promise<Opaque | DeliveryAction> {
      for (;;) {
        // A replayed attempt skips the probe; a push step that then runs live checks again (resumed in attempt).
        if (wf.replaying) {
          const replayed = deps.sessionOf(project, address);
          if (replayed) return replayed;
        }
        const session = deps.sessionOf(project, address);
        const action = await actionFor(session, state, !wf.replaying);
        if (action === "push") return session as Opaque;
        if (action !== "wait") return action;
        await wf.pause(readyPollMs);
      }
    }

    // One push attempt. Resolves "delivered", "failed" (retry after backoff), "cut" (never sent again), "skipped", "expired", "dropped" or "answered".
    async function attempt(attemptNo: number, { allowSeen }: { allowSeen: boolean }): Promise<string> {
      // A restart inside this attempt: target() and the answer re-check below skip their live checks.
      const resumed = wf.replaying;
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
      // A Stop hook that started since the ready check delivers the message itself; the check runs inside the step so replays match.
      const pushed = await wf.step("push", async (): Promise<PushResult> => {
        // A resumed attempt whose push never ran checks now: an answer or busy target during the restart gets no copy.
        if (resumed) {
          const action = await actionFor(session, stateOf(attemptNo), true);
          if (action !== "push") return { status: action === "wait" ? "unsent" : action };
        }
        if (!(await deps.held?.(session, scfg))) return deps.push(session, { text, urgent: current.urgent === true, ids: [id] });
        // The hold reads the hand-off file every second and the mark step hides the inbox copy; a failed hand-off retries.
        if (!deps.handOff) return { status: "held" };
        return Promise.resolve().then(() => (deps.handOff as NonNullable<DeliveryDeps["handOff"]>)(scfg, [current])).then(() => ({ status: "handed" }), () => ({ status: "held" }));
      }, {
        // A restart after the hand-off but before the checkpoint finds the id in the hand-off file.
        onCut: async () => ({ status: deps.handedOff?.(scfg, id) ? "handed" : await deps.waitConfirmed(session, [id], snap) ? "delivered" : "cut" }),
      });
      if (pushed.status === "delivered" || pushed.status === "handed") {
        await wf.step("mark", () => deps.markDelivered(scfg, [id]));
        return "delivered";
      }
      if (["cut", "unsent", "held", "answered", "expired", "dropped"].includes(pushed.status)) {
        await wf.step("release", () => deps.release(scfg, [id], owner));
        return pushed.status === "unsent" || pushed.status === "held" ? "failed" : pushed.status;
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
    async function deliver(attemptNo: number, opts: { allowSeen: boolean }): Promise<string> {
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
