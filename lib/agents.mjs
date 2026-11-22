/**
 * Pulsar-style agent messaging on the existing primitives: inbox (claimInbox plus read receipts), wait (the Stop hook's
 * ntfy stream waiter), respond (a msg envelope with replyTo and state), and send with await_reply.
 */
import { setTimeout as delay } from "node:timers/promises";
import { broadcastTopic, inboxTopic } from "./config.mjs";
import { RESPOND_STATES, claimInbox, parseEnvelope, replyToOperator, sendMessage } from "./inbox.mjs";
import { pollCached } from "./ntfy.mjs";
import { sendReceipts, settleReceipts } from "./receipts.mjs";
import { streamWaiter } from "./stop.mjs";
import { cleanBody } from "./format.mjs";
import { sessionIdleState } from "./idle.mjs";
import { listSessions } from "./sessions.mjs";

export const AGENT_WAIT_MAX_S = 45;
const IDLE_POLL_MS = 1000;
const ADDRESS = /^[a-z0-9-]{1,24}#[a-f0-9]{16}$/;
const HISTORY_TAIL_BYTES = 512 * 1024;
const MESSAGE_ID = /^[a-zA-Z0-9-]{1,64}$/;

function checkSeconds(seconds) {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > AGENT_WAIT_MAX_S) {
    throw new Error(`Wait must be an integer from 0 to ${AGENT_WAIT_MAX_S} seconds`);
  }
}

/** A claimed message as tool output: the body cleaned and capped, plus how to answer it. */
export function messageView(m) {
  // ai-collab's own machinery reaches this inbox under the operator's address; nothing is expected back.
  if (m.system) return { ...m, body: cleanBody(m.body), answer_with: "no reply expected" };
  const respond = m.operatorThread ? "reply_to_operator or respond" : m.from === "ntfy" ? "send to all with reply_to" : "respond";
  return { ...m, body: cleanBody(m.body), answer_with: `${respond} message_id=${m.id}` };
}

/** Claims new messages for this session (peek leaves them unread) and publishes read receipts for claimed ones. */
export async function readInbox(cfg, { peek = false, strict = true, claim = claimInbox } = {}) {
  const messages = await claim(cfg, { commit: !peek, strict });
  if (!peek) {
    sendReceipts(cfg, messages.map((m) => m.id));
    await settleReceipts();
  }
  return messages;
}

/** Blocks up to seconds for new messages to this session; returns {status:"messages"|"timeout", messages}. */
export async function waitForMessages(cfg, { seconds = 25, signal, claim = claimInbox, wait } = {}) {
  checkSeconds(seconds);
  const deadline = Date.now() + seconds * 1000;
  const waitFor = wait ?? streamWaiter(cfg, Date.now());
  for (let first = true; ; first = false) {
    signal?.throwIfAborted();
    const messages = await readInbox(cfg, { strict: first, claim });
    if (messages.length) return { status: "messages", messages };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { status: "timeout", messages: [] };
    if ((await waitFor(remaining, signal)) === "aborted") signal?.throwIfAborted();
  }
}

/**
 * Sends to an address, a peer, or all ("*"). With awaitSeconds > 0, blocks until a reply, done or declined answer to
 * the sent message arrives, then claims the inbox and returns it with every other new message, so none is lost.
 */
export async function sendAndAwait(cfg, to, body, { awaitSeconds = 0, urgent, replyTo, attachment, priority, expectReply, signal, claim = claimInbox, wait } = {}) {
  checkSeconds(awaitSeconds);
  const target = to === "*" ? "all" : to;
  const sent = await sendMessage(cfg, target, body, { urgent, replyTo, attachment, priority, expectReply });
  const out = { sent: true, to: target, ...(sent.id ? { id: sent.id } : {}) };
  if (!awaitSeconds) return out;
  if (!sent.id) return { ...out, status: "pending", note: "ntfy returned no message id, so no reply can be matched." };
  return { ...out, ...await awaitReply(cfg, sent.id, { awaitSeconds, signal, claim, wait }) };
}

/**
 * Blocks up to awaitSeconds for a reply, done or declined to message id, then claims the inbox and returns it with
 * every other new message. Resolves {status: "replied", reply, messages} or {status: "pending", note}.
 */
export async function awaitReply(cfg, id, { awaitSeconds, signal, claim = claimInbox, wait } = {}) {
  checkSeconds(awaitSeconds);
  const deadline = Date.now() + awaitSeconds * 1000;
  const waitFor = wait ?? streamWaiter(cfg, Date.now());
  const final = (m) => m.replyTo === id && m.state !== "working";
  for (;;) {
    signal?.throwIfAborted();
    const peeked = await claim(cfg, { commit: false }).catch(() => []);
    if (peeked.some(final)) {
      const messages = await readInbox(cfg, { strict: false, claim });
      const reply = messages.find(final);
      if (reply) return { status: "replied", reply, messages: messages.filter((m) => m !== reply) };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { status: "pending", note: "No reply yet; call wait to keep listening." };
    if ((await waitFor(remaining, signal)) === "aborted") signal?.throwIfAborted();
  }
}

/**
 * Blocks up to seconds until the agent at address has no turn running. Resolves {status: "idle" | "ended" | "timeout", address};
 * ended means its harness process is gone. The idle signal per harness is in lib/idle.mjs; timeout also covers an unknown state.
 */
export async function waitForIdle(cfg, address, { seconds = 25, signal, idle = sessionIdleState, list = listSessions, sleep = (ms, sig) => delay(ms, undefined, { signal: sig }) } = {}) {
  checkSeconds(seconds);
  if (!ADDRESS.test(address)) throw new Error("idle: needs a session address (peer#label from list_agents)");
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    signal?.throwIfAborted();
    const session = list(cfg).find((item) => item.id === address);
    if (!session) throw new Error("Unknown agent address");
    if (!session.runningJobs) {
      if (!session.online) return { status: "ended", address };
      if (await idle(session) === "idle") return { status: "idle", address };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { status: "timeout", address };
    await sleep(Math.min(IDLE_POLL_MS, remaining), signal).catch(() => signal?.throwIfAborted());
  }
}

/**
 * Blocks up to awaitSeconds until a reply, done or declined, to message id arrives in this session's inbox history.
 * Reads history only: the unread cursor, read receipts and other messages are left alone.
 * Resolves {status: "replied", reply} or {status: "pending"}.
 */
export async function waitForReply(cfg, id, { awaitSeconds = 25, signal, wait, find = findReplyInHistory } = {}) {
  checkSeconds(awaitSeconds);
  if (!MESSAGE_ID.test(id)) throw new Error("wait reply: needs a message id");
  const deadline = Date.now() + awaitSeconds * 1000;
  const waitFor = wait ?? streamWaiter(cfg, Date.now());
  for (;;) {
    signal?.throwIfAborted();
    const reply = await find(cfg, id);
    if (reply) return { status: "replied", reply };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { status: "pending" };
    const outcome = await waitFor(remaining, signal);
    if (outcome === "aborted") signal?.throwIfAborted();
    if (outcome === "error") await delay(Math.min(1000, Math.max(0, deadline - Date.now())));
  }
}

/** The newest reply, done or declined to message id in this session's inbox events, as messageView; read-only. */
export async function findReplyInHistory(cfg, id) {
  const events = await pollCached(cfg, inboxTopic(cfg.project, cfg.peer), "all", undefined, { tailBytes: HISTORY_TAIL_BYTES });
  for (const ev of events.slice().reverse()) {
    const m = parseEnvelope(ev.message);
    if (m?.kind !== "msg" || m.replyTo !== id || m.state === "working" || !RESPOND_STATES.includes(m.state)) continue;
    if (m.to !== cfg.peer || (m.toSession !== undefined && m.toSession !== cfg.session)) continue;
    return messageView({ id: ev.id, from: m.from, to: cfg.peer, ts: m.ts, body: m.body, state: m.state, replyTo: m.replyTo });
  }
  return null;
}

// The envelope (or plain phone text) of a message this session received, found in the newest history of its topics.
async function findReceived(cfg, id) {
  for (const topic of [inboxTopic(cfg.project, cfg.peer), broadcastTopic(cfg.project)]) {
    const events = await pollCached(cfg, topic, "all", undefined, { tailBytes: HISTORY_TAIL_BYTES });
    const event = events.find((ev) => ev.id === id);
    if (!event) continue;
    const m = parseEnvelope(event.message);
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
export async function respond(cfg, id, state, body = "") {
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
