/**
 * Send, status, inbox claim, and peer status reads. All network calls go through lib/ntfy.mjs.
 *
 * Delivery is best-effort: publish failures throw to the caller (CLI) or are
 * swallowed by hooks; there is no outbox or retry (read receipts: lib/receipts.mjs).
 */
import { MAX_BODY_CHARS, NTFY_MESSAGE_MAX_BYTES, SESSION_LABEL, isGithubLogin, isValidName, statusTopic, inboxTopic, broadcastTopic } from "./config.mjs";
import { publish, pollCached, querySafe } from "./ntfy.mjs";
import { deepLink } from "./deep-link.mjs";
import { alertPriority, readAlertLevel } from "./alerts.mjs";
import { parsePhoneReply, parseQuestionText } from "./questions.mjs";
import { readState, writeState, statePath, withLock } from "./state.mjs";
import { parseMode, recordMode } from "./mode.mjs";
import { imageAttachment, readAttachment } from "./attachment.mjs";
import { attachmentOf, cacheAttachmentsWithin, localizedAttachment } from "./attachment-cache.mjs";
import { encodeEnvelope, parseWireEnvelope } from "./agui.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const INITIAL_LOOKBACK_S = 3600; // first contact: deliver messages from the last hour
export const MAX_PER_CLAIM = 20;
export const HISTORY_DEFAULT = 30;
export const HISTORY_MAX = 100;
const HISTORY_TAIL_BYTES = 1024 * 1024; // the newest channel events a history read keeps
const SEEN_MAX = 500;
export const RESERVE_MS = 60_000; // a delivery reservation expires after this, so a crashed pusher cannot hold a message
// A hook may spend this long caching delivered attachments; past it the message arrives with metadata only.
export const ATTACHMENT_BUDGET_MS = 4000;
export { NTFY_MESSAGE_MAX_BYTES };
const HARNESSES = new Set(["claude", "codex", "cursor", "opencode"]);
const MESSAGE_ID = /^[a-zA-Z0-9-]{1,64}$/;
// States of a respond envelope (a msg with replyTo); old clients ignore the field.
export const RESPOND_STATES = ["working", "reply", "done", "declined"];
// normal wakes an idle session, urgent also polls at the next hook, fyi is queued without a wake.
export const PRIORITIES = ["normal", "urgent", "fyi"];

function envelope(cfg, kind, fields) {
  return encodeEnvelope(kind, { from: cfg.peer, ...(cfg.session ? { session: cfg.session } : {}), ...fields }, cfg.wire);
}

export function parseEnvelope(raw) {
  return parseWireEnvelope(raw);
}

/** Status carries metadata only: peer, event, harness, time. No paths, prompts, or output. */
export async function publishStatus(cfg, { event, harness }) {
  const h = HARNESSES.has(harness) ? harness : "other";
  const msg = envelope(cfg, "status", { event, harness: h, ...(cfg.parent ? { parent: cfg.parent } : {}), ts: new Date().toISOString() });
  await publish(cfg, statusTopic(cfg.project), msg, { title: "ai-collab status", priority: alertPriority(readAlertLevel(), "other") });
}

// The chat an @mention came from: "all" (the project chat) or a session address.
const MENTIONED_IN = /^(all|[a-z0-9-]{1,24}#[a-f0-9]{16})$/;
// The run ID of a subagent that an @mention names; the parent session relays it.
const SUBAGENT_RUN = /^[A-Za-z0-9_-]{1,64}$/;
// A team name when the operator routed work to a team orchestrator.
const TEAM_NAME = /^(?=.{1,24}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Sends one msg envelope; resolves {topic, id}. urgent marks it for delivery at the recipient's next hook (markUrgent);
 * state (with replyTo) answers a message as working, reply, done or declined; by names the operator's GitHub login;
 * forSubagent names the subagent run (of the target session) that the message is for.
 * priority is normal, urgent (same as urgent: true) or fyi (queued, never wakes an idle session);
 * expectReply marks a direct message the dispatcher redelivers until the target answers (web/server/dispatch.mjs);
 * system marks text ai-collab's own machinery sends (a compaction request, a pattern-run notice) under the operator's
 * address: it reaches the operator's own reply routes, but readers show the sender as "system", not as the operator.
 * startOnly marks a project-chat post that only starts sessions, so no running session takes it.
 */
export async function sendMessage(cfg, target, body, { operatorThread, system, replyTo, attachment, urgent, state, by, mentionedIn, forSubagent, forTeam, priority, expectReply, startOnly, onPublished } = {}) {
  if (!cfg.enabled) throw new Error(`disabled: ${cfg.reason}`);
  const [peer, session, ...extra] = String(target).split("#");
  if (!isValidName(peer) || extra.length || (session !== undefined && (peer === "all" || !SESSION_LABEL.test(session)))) {
    throw new Error(`invalid peer name "${target}"`);
  }
  if (peer !== "all" && cfg.peers.length && !cfg.peers.includes(peer)) {
    throw new Error(`peer "${target}" is not in AI_COLLAB_PEERS`);
  }
  if (typeof body !== "string" || (!body.trim() && attachment === undefined)) throw new Error("empty message");
  if (body.length > MAX_BODY_CHARS) throw new Error(`message is over ${MAX_BODY_CHARS} characters`);
  const topic = peer === "all" ? broadcastTopic(cfg.project) : inboxTopic(cfg.project, peer);
  if (operatorThread && (cfg.peer !== "operator" || !session)) throw new Error("Direct chats require a session");
  if (replyTo !== undefined && !MESSAGE_ID.test(replyTo)) throw new Error("invalid reply_to message ID");
  if (state !== undefined && (!RESPOND_STATES.includes(state) || !replyTo)) throw new Error("state must be working, reply, done or declined, with reply_to");
  if (by !== undefined && (cfg.peer !== "operator" || !isGithubLogin(by))) throw new Error("by must be a GitHub login on an operator message");
  if (system !== undefined && (system !== true || cfg.peer !== "operator")) {
    throw new Error("system messages are ai-collab's own, sent from the operator address");
  }
  if (mentionedIn !== undefined && !MENTIONED_IN.test(mentionedIn)) throw new Error("invalid mentionedIn chat");
  if (forSubagent !== undefined && !SUBAGENT_RUN.test(forSubagent)) throw new Error("invalid forSubagent run ID");
  if (forTeam !== undefined && !TEAM_NAME.test(forTeam)) throw new Error("invalid forTeam name");
  if (priority !== undefined && !PRIORITIES.includes(priority)) throw new Error("priority must be normal, urgent or fyi");
  if (priority === "fyi" && urgent === true) throw new Error("a message cannot be both fyi and urgent");
  if (expectReply !== undefined && typeof expectReply !== "boolean") throw new Error("expect_reply must be true or false");
  if (expectReply === true && (peer === "all" || priority === "fyi")) throw new Error("expect_reply needs a direct, non-fyi message");
  if (startOnly !== undefined && typeof startOnly !== "boolean") throw new Error("start_only must be true or false");
  if (startOnly === true && peer !== "all") throw new Error("start_only needs the project chat");
  if (priority === "urgent") urgent = true;
  const sent = await sendEnvelope(cfg, topic, {
    to: peer, ...(session ? { toSession: session } : {}), ts: new Date().toISOString(), body,
    ...(operatorThread ? { operatorThread: true } : {}),
    ...(system === true ? { system: true } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(state ? { state } : {}),
    ...(urgent === true ? { urgent: true } : {}),
    ...(priority === "fyi" ? { priority } : {}),
    ...(expectReply === true ? { expectReply: true } : {}),
    ...(startOnly === true ? { startOnly: true } : {}),
    ...(by ? { by } : {}),
    ...(mentionedIn ? { mentionedIn } : {}),
    ...(forSubagent ? { forSubagent } : {}),
    ...(forTeam ? { forTeam } : {}),
  }, { attachment, onPublished });
  if (urgent === true) markUrgent(cfg, String(target));
  return sent;
}

function urgentFile(cfg, target) {
  return path.join(cfg.stateDir, cfg.project, "urgent", target);
}

/**
 * Records that an urgent message for target (all, peer, or peer#session) was published. Hooks on this machine read
 * the marker before their poll throttle, so the next hook event polls ntfy at once. Best effort: errors are ignored.
 */
export function markUrgent(cfg, target, now = Date.now()) {
  try {
    const file = urgentFile(cfg, target);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, String(now), { mode: 0o600 });
  } catch { /* the message still arrives at the next unthrottled poll */ }
}

/** True when an urgent message for this peer or session was marked after `at` (ms). Costs up to three small file reads. */
export function urgentSince(cfg, at) {
  const targets = ["all", cfg.peer, ...(cfg.session ? [`${cfg.peer}#${cfg.session}`] : [])];
  return targets.some((target) => {
    try { return Number(readFileSync(urgentFile(cfg, target), "utf8")) > at; } catch { return false; }
  });
}

async function sendEnvelope(cfg, topic, fields, { attachment, onPublished } = {}) {
  const msg = envelope(cfg, "msg", fields);
  // With an attachment the message travels in the query string, respelled by querySafe.
  if (Buffer.byteLength(attachment === undefined ? msg : querySafe(msg)) > NTFY_MESSAGE_MAX_BYTES) {
    throw new Error(`encoded message exceeds ntfy’s ${NTFY_MESSAGE_MAX_BYTES}-byte limit`);
  }
  const attach = attachment === undefined ? undefined
    : Buffer.isBuffer(attachment?.data) && typeof attachment.filename === "string"
      ? imageAttachment(attachment.filename, attachment.data) : readAttachment(attachment);
  const from = cfg.session ? `${cfg.peer}#${cfg.session}` : cfg.peer;
  const id = await publish(cfg, topic, msg, { title: `ai-collab from ${from}`, attach, onPublished, click: deepLink({ project: cfg.project, session: cfg.session ? from : "" }), priority: alertPriority(readAlertLevel(), "direct") });
  return { topic, ...(typeof id === "string" ? { id } : {}) };
}

export async function replyToOperator(cfg, id, body, { attachment, state } = {}) {
  if (!cfg.session || typeof id !== "string" || !MESSAGE_ID.test(id)) {
    throw new Error("Use the session and message ID supplied by the ai-collab hook");
  }
  if (typeof body !== "string" || !body.trim() || body.length > MAX_BODY_CHARS) {
    throw new Error("Enter 1–4000 characters");
  }
  const topic = inboxTopic(cfg.project, cfg.peer);
  const history = await pollCached(cfg, topic, "all");
  const original = parseEnvelope(history.find((event) => event.id === id)?.message);
  if (original?.kind !== "msg" || original.from !== "operator" || original.operatorThread !== true ||
      original.to !== cfg.peer || original.toSession !== cfg.session) {
    throw new Error("This operator message is unavailable for your session");
  }
  if (state !== undefined && !RESPOND_STATES.includes(state)) throw new Error("state must be working, reply, done or declined");
  await sendEnvelope(cfg, topic, {
    to: "operator", operatorThread: true, replyTo: id, ts: new Date().toISOString(), body, ...(state ? { state } : {}),
  }, { attachment });
  return { sent: true };
}

// A project-chat @tag: a harness, harness#session, harness#session/run, or harness:model.
const AGENT_MENTION = /(^|[^\w#-])@([a-z0-9-]{1,24}(?:#[a-f0-9]{16}(?:\/[A-Za-z0-9_-]{1,64})?|:[A-Za-z0-9][A-Za-z0-9._/-]{0,119})?)(?![\w-])/g;

/**
 * True when a project-chat body addresses this agent. `@peer` names the harness and wakes every session of it.
 * `@peer#session` (and `@peer#session/run`) names that session. A `@peer:model` tag starts a new session and does not.
 */
export function mentionsAgent(body, { peer, session } = {}) {
  if (!peer) return false;
  const address = session ? `${peer}#${session}` : "";
  for (const match of String(body).matchAll(AGENT_MENTION)) {
    const name = match[2].replace(/\.+$/, "");
    if (name === peer) return true;
    if (address && (name === address || name.startsWith(`${address}/`))) return true;
  }
  return false;
}

/**
 * Read new messages for this peer (direct inbox plus broadcast).
 * - throttle: skip the network if the last poll was < pollIntervalMs ago (hot hooks), unless an urgent marker is newer.
 * - commit: false = peek, no cursor or dedup writes.
 * - strict: rethrow errors and lock contention instead of returning [] (CLI).
 * Cursors advance only past events that were processed, so a cap or failure
 * leaves the remainder for the next claim.
 * An agent session (cfg.session set) takes a project-chat post only when mentionsAgent matches.
 * A direct message, including one to the peer inbox, is always taken. A claim with no session is the
 * peer inbox and still sees the channel. Phone alert priority is unchanged.
 */
export async function claimInbox(cfg, opts = {}) {
  const { now = Date.now(), throttle = false, commit = true, strict = false, limit = MAX_PER_CLAIM, accept = () => true, poll = null, peek = null, limited = null } = opts;
  if (!cfg.enabled) return [];
  const file = statePath(cfg);
  const inbox = inboxTopic(cfg.project, cfg.peer);
  const all = broadcastTopic(cfg.project);
  const snapshot = readState(file);
  if (throttle && cfg.pollIntervalMs > 0 && now - snapshot.lastPollAt < cfg.pollIntervalMs && !urgentSince(cfg, snapshot.lastPollAt)) return [];
  // Network reads run before the lock; the lock covers only the state read, the apply and the write.
  const fetched = await fetchTopics(cfg, snapshot, [inbox, all], now, { poll, peek, file, limited });
  const apply = (state) => applyEvents(cfg, state, fetched, { inbox, all, now, limit, accept, strict });
  if (!commit) {
    try {
      const state = readState(file);
      const out = apply(state);
      if (peek && out.length === 0) recordPeek(peek, file, snapshot, fetched, state, [inbox, all]);
      return out;
    } catch (err) {
      if (strict) throw err;
      return [];
    }
  }
  try {
    const r = await withLock(file, () => {
      const state = readState(file);
      state.lastPollAt = now;
      const out = apply(state);
      state.reserved = Object.fromEntries(Object.entries(state.reserved).filter(([, v]) => untilOf(v) > now));
      writeState(file, state);
      return out;
    });
    if (!r.locked) {
      if (strict) throw new Error("another ai-collab process holds the inbox lock; retry");
      return [];
    }
    // A delivered attachment is cached once for the whole machine, outside the lock and under a short budget,
    // so the agent reads the file the UI already has instead of downloading it from ntfy again.
    return r.value.some((m) => m.attachment && !m.attachment.local_path)
      ? await cacheAttachmentsWithin(cfg, r.value, { budgetMs: ATTACHMENT_BUDGET_MS })
      : r.value;
  } catch (err) {
    if (strict) throw err;
    return [];
  }
}

// Queue changes share the inbox lock with hook claims and push reservations.
export async function changeQueuedMessage(cfg, id, change) {
  const file = statePath(cfg);
  const result = await withInboxLock(file, () => {
    const state = readState(file);
    if (state.seen.includes(id) || untilOf(state.reserved[id]) > Date.now() || state.queue?.[id]?.cancelled) return false;
    state.queue = { ...state.queue, [id]: { ...state.queue?.[id], ...change } };
    writeState(file, state);
    return true;
  });
  return result.locked && result.value;
}

export function queuedMessage(message, state) {
  const change = state.queue?.[message.id];
  return change?.cancelled ? null : change ? { ...message, ...change } : message;
}

// A push can peek before an edit, so resolve its payload again after reserving.
export function reservedMessage(cfg, message) {
  return queuedMessage(message, readState(statePath(cfg)));
}

function committedId(state, topic) {
  const cur = state.topics[topic];
  return cur && typeof cur === "object" && typeof cur.id === "string" ? cur.id : "";
}

// A peek is a read position per lane (live or wake path), state file and topic: each path refuses different messages.
function peekKey(lane, file, topic) {
  return `${lane}\n${file}\n${topic}`;
}

// Polls each topic from the peek position while it still follows the committed cursor, else from the committed cursor.
// A failed topic is kept as its error (fail open per topic). poll memoizes reads by topic and since across sessions in one tick.
// limited holds the topics that answered 429 earlier in the tick: they are not polled again.
async function fetchTopics(cfg, state, topics, now, { poll = null, peek = null, file = "", limited = null } = {}) {
  const fetched = new Map();
  for (const topic of topics) {
    if (limited?.has(topic)) {
      fetched.set(topic, { error: Object.assign(new Error("topic rate limited earlier this tick"), { ntfyStatus: 429 }) });
      continue;
    }
    const committed = committedId(state, topic);
    const peeked = peek?.cursors.get(peekKey(peek.lane, file, topic));
    const since = peeked && peeked.base === committed ? peeked.id : committed || String(Math.floor(now / 1000) - INITIAL_LOOKBACK_S);
    try {
      const key = `${topic}\n${since}`;
      let read = poll?.get(key);
      if (!read) {
        read = pollCached(cfg, topic, since);
        poll?.set(key, read);
      }
      fetched.set(topic, { events: await read });
    } catch (err) {
      fetched.set(topic, { error: err });
      if (err.ntfyStatus === 429) limited?.add(topic);
    }
  }
  return fetched;
}

// After a peek that returned nothing, moves the in-memory read position past the events it examined, so an idle
// session stops re-reading the same broadcast backlog. Only memory: the committed cursor is never written here.
function recordPeek(peek, file, snapshot, fetched, state, topics) {
  for (const topic of topics) {
    if (fetched.get(topic)?.error) continue;
    const id = committedId(state, topic);
    const base = committedId(snapshot, topic);
    if (id && id !== base) peek.cursors.set(peekKey(peek.lane, file, topic), { base, id });
  }
}

// Applies fetched events to state: cursor, seen ids, mode, and the messages this session takes.
// A reserved id belongs to a push in flight: the cursor stops before it, so a failed push can still deliver it.
// accept(message) decides whether a message counts toward limit; a refused one is neither returned nor counted.
function applyEvents(cfg, state, fetched, { inbox, all, now, limit, accept, strict }) {
  const seen = new Set(state.seen);
  const reserved = new Set(liveReserved(state, now));
  const out = [];
  let lastError = null;
  const add = (message) => {
    if (accept(message)) out.push(message);
  };
  for (const topic of [inbox, all]) {
    if (out.length >= limit) break;
    const f = fetched.get(topic);
    if (!f) continue;
    if (f.error) {
      lastError = f.error;
      continue;
    }
    const cur = state.topics[topic] && typeof state.topics[topic] === "object" ? state.topics[topic] : {};
    state.topics[topic] = cur;
    for (const ev of f.events) {
      if (out.length >= limit) break;
      if (reserved.has(ev.id)) break;
      cur.id = ev.id;
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      const m = parseEnvelope(ev.message);
      if ((!m || m.kind === "question") && topic === all && ev.message.trim() && !parsePhoneReply(ev.message)) {
        const question = parseQuestionText(m || ev.message);
        if (m && !question) continue;
        if (question && cfg.session && question.sender === `${cfg.peer}#${cfg.session}`) continue; // own question
        const text = (question?.text ?? ev.message).slice(0, MAX_BODY_CHARS);
        // Channel text wakes an agent session only when it @mentions that session or its harness.
        if (cfg.session && !mentionsAgent(text, cfg)) continue;
        add({
          id: ev.id, from: "ntfy", to: "all", ts: "", body: text,
          ...(question ? {} : { operatorBroadcast: true }),
        });
        continue;
      }
      if (topic === all && m?.kind === "mode") {
        recordMode(state, parseMode(m));
        continue;
      }
      if (!m || m.kind !== "msg" || typeof m.body !== "string") continue;
      if (!isValidName(m.from)) continue;
      const senderSession = typeof m.session === "string" && SESSION_LABEL.test(m.session) ? m.session : "";
      if (m.from === cfg.peer && (!senderSession || !cfg.session || senderSession === cfg.session)) continue;
      const wantTo = topic === inbox ? cfg.peer : "all";
      if (m.to !== wantTo || (m.toSession !== undefined && m.toSession !== cfg.session)) continue;
      // A start-only post (only @harness:model tags) addresses the sessions its tags start; no running session takes it.
      if (topic === all && m.from === "operator" && m.startOnly === true && m.toSession === undefined) continue;
      // An agent session does not take project-chat noise. The cursor has already moved past it, so it never starts a turn.
      // A direct message was accepted above. An operator post that @mentions this session or its harness is kept.
      if (topic === all && cfg.session && !mentionsAgent(m.body, cfg)) continue;
      const operatorThread = m.from === "operator" && m.operatorThread === true && Boolean(m.toSession);
      const operatorBroadcast = m.from === "operator" && topic === all;
      // A screenshot travels as an ntfy attachment; local_path appears once this machine has the file cached.
      const attachment = attachmentOf(ev);
      const message = queuedMessage({
        id: ev.id,
        from: senderSession ? `${m.from}#${senderSession}` : m.from,
        to: m.toSession ? `${m.to}#${m.toSession}` : m.to,
        ts: typeof m.ts === "string" && /^[\w:.+-]{1,40}$/.test(m.ts) ? m.ts : "",
        body: m.body.slice(0, MAX_BODY_CHARS),
        ...(operatorThread ? { operatorThread: true } : {}),
        ...(operatorBroadcast ? { operatorBroadcast: true } : {}),
        ...(m.from === "operator" && m.system === true ? { system: true } : {}),
        ...(typeof m.replyTo === "string" && MESSAGE_ID.test(m.replyTo) ? { replyTo: m.replyTo } : {}),
        ...(RESPOND_STATES.includes(m.state) ? { state: m.state } : {}),
        ...(m.urgent === true ? { urgent: true } : {}),
        ...(m.priority === "fyi" ? { priority: "fyi" } : {}),
        ...(m.expectReply === true ? { expectReply: true } : {}),
        ...(m.from === "operator" && isGithubLogin(m.by) ? { by: m.by } : {}),
        ...(m.from === "operator" && typeof m.mentionedIn === "string" && MENTIONED_IN.test(m.mentionedIn) ? { mentionedIn: m.mentionedIn } : {}),
        ...(m.from === "operator" && typeof m.forSubagent === "string" && SUBAGENT_RUN.test(m.forSubagent) ? { forSubagent: m.forSubagent } : {}),
        ...(m.from === "operator" && typeof m.forTeam === "string" && TEAM_NAME.test(m.forTeam) ? { forTeam: m.forTeam } : {}),
        // A screenshot travels as an ntfy attachment; local_path appears once this machine has the file cached.
        ...(attachment ? { attachment: localizedAttachment(cfg, attachment) } : {}),
      }, state);
      if (message) add(message);
    }
  }
  if (strict && lastError && out.length === 0) throw lastError;
  state.seen = [...seen].slice(-SEEN_MAX);
  return out;
}

/**
 * Newest `limit` msg envelopes on the project's all topic, oldest first. Read-only: no cursor, no receipts.
 */
export async function channelHistory(cfg, { limit = HISTORY_DEFAULT } = {}) {
  if (!cfg.enabled) throw new Error(`disabled: ${cfg.reason}`);
  const events = await pollCached(cfg, broadcastTopic(cfg.project), "all", undefined, { tailBytes: HISTORY_TAIL_BYTES });
  const out = [];
  for (const ev of events) {
    const m = parseEnvelope(ev.message);
    if (m?.kind !== "msg" || typeof m.body !== "string" || m.to !== "all" || m.toSession !== undefined || !isValidName(m.from)) continue;
    const senderSession = typeof m.session === "string" && SESSION_LABEL.test(m.session) ? m.session : "";
    // An image in history names its cached copy when this machine has one, so a reader never re-downloads it.
    const attachment = attachmentOf(ev);
    out.push({
      id: ev.id,
      from: senderSession ? `${m.from}#${senderSession}` : m.from,
      to: "all",
      ts: typeof m.ts === "string" && /^[\w:.+-]{1,40}$/.test(m.ts) ? m.ts : "",
      body: m.body.slice(0, MAX_BODY_CHARS),
      ...(m.from === "operator" && isGithubLogin(m.by) ? { by: m.by } : {}),
      ...(attachment ? { attachment: localizedAttachment(cfg, attachment) } : {}),
    });
  }
  return out.slice(-Math.min(Math.max(Math.trunc(Number(limit)) || HISTORY_DEFAULT, 1), HISTORY_MAX));
}

// Ids reserved by a pusher that have not expired yet.
function liveReserved(state, now) {
  return Object.keys(state.reserved).filter((id) => untilOf(state.reserved[id]) > now);
}

// A reservation is a number (an expiry, the dispatcher's) or {until, owner} (a workflow's).
function untilOf(v) {
  return typeof v === "number" ? v : (v?.until ?? 0);
}

function ownerOf(v) {
  return typeof v === "object" && v ? v.owner : null;
}

// Runs fn under the inbox lock, retrying once with a longer wait; { locked: false } when both attempts fail.
async function withInboxLock(file, fn) {
  const first = await withLock(file, fn);
  return first.locked ? first : withLock(file, fn, { waitMs: 5000 });
}

/**
 * Reserves messages for one delivery path under the inbox lock, so the waiter's claim and the dispatcher's push cannot
 * both take one. Returns the ids this caller owns; [] when the lock is busy. allowSeen reserves ids already delivered
 * (a redelivery), so the seen list can be trimmed without exposing them.
 */
export async function reserveDelivery(cfg, ids, { now = Date.now(), ttlMs = RESERVE_MS, allowSeen = false } = {}) {
  const file = statePath(cfg);
  const r = await withInboxLock(file, () => {
    const state = readState(file);
    const taken = new Set([...(allowSeen ? [] : state.seen), ...liveReserved(state, now)]);
    const own = ids.filter((id) => !taken.has(id) && !state.queue?.[id]?.cancelled);
    for (const id of own) state.reserved[id] = now + ttlMs;
    writeState(file, state);
    return own;
  });
  return r.locked ? r.value : [];
}

/** Drops reservations after a failed push or an expired confirmation, so the waiter and the hooks can take the messages. */
export async function releaseDelivery(cfg, ids) {
  const file = statePath(cfg);
  await withInboxLock(file, () => {
    const state = readState(file);
    for (const id of ids) delete state.reserved[id];
    writeState(file, state);
  });
}

/** Marks messages as delivered by another path (the dispatcher), so this session's hooks skip them. */
export async function markDelivered(cfg, ids) {
  const file = statePath(cfg);
  await withInboxLock(file, () => {
    const state = readState(file);
    state.seen = [...new Set([...state.seen, ...ids])].slice(-SEEN_MAX);
    for (const id of ids) delete state.reserved[id];
    writeState(file, state);
  });
}

/** Latest status per peer seen in the last `since` window (ntfy duration). */
export async function readStatuses(cfg, { since = "24h" } = {}) {
  return latestStatuses(await pollCached(cfg, statusTopic(cfg.project), since));
}

/** Latest status per peer or peer#session in a list of status-topic events, oldest first. */
export function latestStatuses(events, latest = new Map()) {
  for (const ev of events) {
    const m = parseEnvelope(ev.message);
    if (!m || m.kind !== "status" || !isValidName(m.from)) continue;
    const session = typeof m.session === "string" && SESSION_LABEL.test(m.session) ? m.session : "";
    latest.set(session ? `${m.from}#${session}` : m.from, {
      event: String(m.event || "").slice(0, 10),
      harness: String(m.harness || "").slice(0, 10),
      ts: String(m.ts || "").slice(0, 40),
      ...(typeof m.parent === "string" && /^[a-z0-9-]{1,24}#[a-f0-9]{16}$/.test(m.parent) ? { parent: m.parent } : {}),
    });
  }
  return latest;
}

/**
 * Reserves messages for one workflow owner (its workflow id). The owner re-acquires its own reservations, so a restart
 * resumes them. Resolves {owned, busy}: owned are the ids this owner holds; busy is true when the inbox lock stayed taken.
 */
export async function reserveOwned(cfg, ids, { owner, now = Date.now(), ttlMs = RESERVE_MS, allowSeen = false } = {}) {
  const file = statePath(cfg);
  const r = await withInboxLock(file, () => {
    const state = readState(file);
    const seen = new Set(allowSeen ? [] : state.seen);
    const own = ids.filter((id) => !seen.has(id) && !state.queue?.[id]?.cancelled && (untilOf(state.reserved[id]) <= now || ownerOf(state.reserved[id]) === owner));
    for (const id of own) state.reserved[id] = { until: now + ttlMs, owner };
    writeState(file, state);
    return own;
  });
  return r.locked ? { owned: r.value, busy: false } : { owned: [], busy: true };
}

/** Drops this owner's reservations after a failed push or an expired confirmation; another owner's stay. */
export async function releaseOwned(cfg, ids, owner) {
  const file = statePath(cfg);
  await withInboxLock(file, () => {
    const state = readState(file);
    for (const id of ids) if (ownerOf(state.reserved[id]) === owner) delete state.reserved[id];
    writeState(file, state);
  });
}
