/**
 * Pulsar-style agent messaging on the existing primitives: inbox (claimInbox plus read receipts), wait (the Stop hook's
 * bus stream waiter), respond (a msg envelope with replyTo and state), and send with await_reply.
 */
import { broadcastTopic, inboxTopic } from "./config.ts";
import { RESPOND_STATES, claimInbox, parseEnvelope, replyToOperator, sendMessage, type AttachmentInput, type Cfg, type InboxMessage, type Step } from "./messaging.ts";
import { pollCached } from "./messaging.ts";
import { readInbox, streamWaiter, waitUntil } from "./messaging.ts";
import { cleanBody } from "./format.ts";
import { sessionIdleState, type IdleState } from "./idle.ts";
import { listSessions } from "./sessions/registry.ts";
import { assertWaitSeconds } from "./operator.ts";

const IDLE_POLL_MS = 1000;
const REPLY_ERROR_PAUSE_MS = 1000;
const ADDRESS = /^[a-z0-9-]{1,24}#[a-f0-9]{16}$/;
const HISTORY_TAIL_BYTES = 512 * 1024;
const MESSAGE_ID = /^[a-zA-Z0-9-]{1,64}$/;

// oxlint-disable-next-line typescript/no-explicit-any -- envelopes and listed sessions are bus and registry JSON read field by field
type Json = any;
type Claim = typeof claimInbox;
type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
export type MessageView = InboxMessage & { answer_with: string };
export type AwaitedReply = { status: "replied"; reply: MessageView | InboxMessage; messages: InboxMessage[] } | { status: "pending"; note: string };
/** A sent message, plus the reply or a pending note when the send waited. */
export type SendResult = { sent: boolean; to: string; id?: string } & ({ status?: undefined } | AwaitedReply);
export type IdleOutcome = { status: "idle" | "ended" | "timeout"; address: string };

/** A claimed message as tool output: the body cleaned and capped, plus how to answer it. */
export function messageView(m: InboxMessage): MessageView {
  // ai-collab's own machinery reaches this inbox under the operator's address; nothing is expected back.
  if (m.system) return { ...m, body: cleanBody(m.body), answer_with: "no reply expected" };
  const respond = m.operatorThread ? "reply_to_operator or respond" : m.from === "ntfy" ? "send to all with reply_to" : "respond";
  return { ...m, body: cleanBody(m.body), answer_with: `${respond} message_id=${m.id}` };
}

/** Blocks up to seconds for new messages to this session; returns {status:"messages"|"timeout", messages}. */
export async function waitForMessages(cfg: Cfg, { seconds = 25, signal, claim = claimInbox, wait }: { seconds?: number; signal?: AbortSignal; claim?: Claim; wait?: Step } = {}) {
  assertWaitSeconds(seconds);
  signal?.throwIfAborted();
  const r = await waitUntil({
    deadline: Date.now() + seconds * 1000,
    signal,
    stream: wait ?? streamWaiter(cfg, Date.now()),
    until: async (first) => {
      const messages = await readInbox(cfg, { strict: first, claim });
      return messages.length ? messages : undefined;
    },
  });
  if (r.status === "hit") return { status: "messages", messages: r.value };
  if (r.status === "aborted") signal?.throwIfAborted();
  return { status: "timeout", messages: [] };
}

/**
 * Sends to an address, a peer, or all ("*"). With awaitSeconds > 0, blocks until a reply, done or declined answer to
 * the sent message arrives, then claims the inbox and returns it with every other new message, so none is lost.
 */
export async function sendAndAwait(cfg: Cfg, to: string, body: string, { awaitSeconds = 0, urgent, replyTo, attachment, priority, expectReply, signal, claim = claimInbox, wait }: {
  awaitSeconds?: number; urgent?: boolean; replyTo?: string; attachment?: AttachmentInput; priority?: string; expectReply?: boolean; signal?: AbortSignal; claim?: Claim; wait?: Step;
} = {}): Promise<SendResult> {
  assertWaitSeconds(awaitSeconds);
  const target = to === "*" ? "all" : to;
  const sent = await sendMessage(cfg, target, body, { urgent, replyTo, attachment, priority, expectReply });
  const out = { sent: true, to: target, ...(sent.id ? { id: sent.id } : {}) };
  if (!awaitSeconds) return out;
  if (!sent.id) return { ...out, status: "pending", note: "the bus returned no message id, so no reply can be matched." };
  return { ...out, ...await awaitReply(cfg, sent.id, { awaitSeconds, signal, claim, wait }) };
}

/**
 * Blocks up to awaitSeconds for a reply, done or declined to message id, then claims the inbox and returns it with
 * every other new message. Resolves {status: "replied", reply, messages} or {status: "pending", note}.
 */
export async function awaitReply(cfg: Cfg, id: string, { awaitSeconds, signal, claim = claimInbox, wait }: { awaitSeconds?: number; signal?: AbortSignal; claim?: Claim; wait?: Step } = {}): Promise<AwaitedReply> {
  assertWaitSeconds(awaitSeconds);
  signal?.throwIfAborted();
  const final = (m: InboxMessage) => m.replyTo === id && m.state !== "working";
  const r = await waitUntil({
    deadline: Date.now() + (awaitSeconds as number) * 1000,
    signal,
    stream: wait ?? streamWaiter(cfg, Date.now()),
    until: async () => {
      const peeked = await readInbox(cfg, { peek: true, strict: false, claim }).catch((): InboxMessage[] => []);
      if (!peeked.some(final)) return undefined;
      const messages = await readInbox(cfg, { strict: false, claim });
      const reply = messages.find(final);
      return reply ? { reply, messages: messages.filter((m) => m !== reply) } : undefined;
    },
  });
  if (r.status === "hit") return { status: "replied", ...r.value };
  if (r.status === "aborted") signal?.throwIfAborted();
  return { status: "pending", note: "No reply yet; call wait to keep listening." };
}

/**
 * Blocks up to seconds until the agent at address has no turn running. Resolves {status: "idle" | "ended" | "timeout", address};
 * ended means its harness process is gone. The idle signal per harness is in lib/idle.ts; timeout also covers an unknown state.
 */
export async function waitForIdle(cfg: Cfg, address: string, { seconds = 25, signal, idle = sessionIdleState, list = listSessions, sleep }: {
  seconds?: number; signal?: AbortSignal; idle?: (session: Json) => Promise<IdleState>; list?: (cfg: Cfg) => Json[]; sleep?: Sleep;
} = {}): Promise<IdleOutcome> {
  assertWaitSeconds(seconds);
  if (!ADDRESS.test(address)) throw new Error("idle: needs a session address (peer#label from list_agents)");
  signal?.throwIfAborted();
  const r = await waitUntil<IdleOutcome>({
    deadline: Date.now() + seconds * 1000,
    signal,
    poll: { intervalMs: IDLE_POLL_MS, sleep },
    until: async () => {
      const session = list(cfg).find((item: Json) => item.id === address);
      if (!session) throw new Error("Unknown agent address");
      if (session.runningJobs) return undefined;
      if (!session.online) return { status: "ended", address };
      return await idle(session) === "idle" ? { status: "idle", address } : undefined;
    },
  });
  if (r.status === "hit") return r.value;
  if (r.status === "aborted") signal?.throwIfAborted();
  return { status: "timeout", address };
}

/**
 * Blocks up to awaitSeconds until a reply, done or declined, to message id arrives in this session's inbox history.
 * Reads history only: the unread cursor, read receipts and other messages are left alone.
 * Resolves {status: "replied", reply} or {status: "pending"}.
 */
export async function waitForReply(cfg: Cfg, id: string, { awaitSeconds = 25, signal, wait, find = findReplyInHistory }: {
  awaitSeconds?: number; signal?: AbortSignal; wait?: Step; find?: (cfg: Cfg, id: string) => Promise<MessageView | null>;
} = {}) {
  assertWaitSeconds(awaitSeconds);
  if (!MESSAGE_ID.test(id)) throw new Error("wait reply: needs a message id");
  signal?.throwIfAborted();
  const r = await waitUntil({
    deadline: Date.now() + awaitSeconds * 1000,
    signal,
    stream: wait ?? streamWaiter(cfg, Date.now()),
    errorPauseMs: REPLY_ERROR_PAUSE_MS,
    until: async () => (await find(cfg, id)) ?? undefined,
  });
  if (r.status === "hit") return { status: "replied" as const, reply: r.value };
  if (r.status === "aborted") signal?.throwIfAborted();
  return { status: "pending" as const };
}

/** The newest reply, done or declined to message id in this session's inbox events, as messageView; read-only. */
export async function findReplyInHistory(cfg: Cfg, id: string): Promise<MessageView | null> {
  const events = await pollCached(cfg, inboxTopic(cfg.project, cfg.peer), "all", undefined, { tailBytes: HISTORY_TAIL_BYTES });
  for (const ev of events.slice().reverse()) {
    const m: Json = parseEnvelope(ev.message);
    if (m?.kind !== "msg" || m.replyTo !== id || m.state === "working" || !RESPOND_STATES.includes(m.state)) continue;
    if (m.to !== cfg.peer || (m.toSession !== undefined && m.toSession !== cfg.session)) continue;
    return messageView({ id: ev.id, from: m.from, to: cfg.peer, ts: m.ts, body: m.body, state: m.state, replyTo: m.replyTo });
  }
  return null;
}

// The envelope (or plain phone text) of a message this session received, found in the newest history of its topics.
async function findReceived(cfg: Cfg, id: string): Promise<{ broadcast: boolean; plain?: boolean; envelope?: Json } | null> {
  for (const topic of [inboxTopic(cfg.project, cfg.peer), broadcastTopic(cfg.project)]) {
    const events = await pollCached(cfg, topic, "all", undefined, { tailBytes: HISTORY_TAIL_BYTES });
    const event = events.find((ev) => ev.id === id);
    if (!event) continue;
    const m: Json = parseEnvelope(event.message);
    if (!m) return topic === inboxTopic(cfg.project, cfg.peer) ? null : { broadcast: true, plain: true };
    if (m.kind !== "msg") return null;
    const toMe = topic === broadcastTopic(cfg.project) ? m.to === "all" : m.to === cfg.peer && (m.toSession === undefined || m.toSession === cfg.session);
    return toMe ? { broadcast: topic === broadcastTopic(cfg.project), envelope: m } : null;
  }
  return null;
}

/**
 * Answers a received message with state working | reply | done | declined: an operator direct chat in its thread,
 * a broadcast or operator message on the shared channel, a peer message to its sender's session.
 */
export async function respond(cfg: Cfg, id: unknown, state: string, body: unknown = ""): Promise<{ sent: true; to: string; state: string }> {
  if (!cfg.session) throw new Error("Pass the session label supplied by the ai-collab hook");
  if (typeof id !== "string" || !MESSAGE_ID.test(id)) throw new Error("Invalid message ID");
  if (!RESPOND_STATES.includes(state)) throw new Error("state must be working, reply, done or declined");
  const text = typeof body === "string" && body.trim() ? body : state;
  const found = await findReceived(cfg, id);
  if (!found) throw new Error("That message is unavailable for your session");
  const m = found.envelope;
  if (m?.from === "operator" && m.operatorThread === true) {
    await replyToOperator(cfg, id, text, { state });
    return { sent: true, to: "operator", state };
  }
  const to = found.broadcast || m.from === "operator" ? "all" : (typeof m.session === "string" && m.session ? `${m.from}#${m.session}` : m.from);
  await sendMessage(cfg, to, text, { replyTo: id, state });
  return { sent: true, to, state };
}
