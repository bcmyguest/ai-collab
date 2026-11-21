/**
 * Send, status, inbox claim, and peer status reads. All network calls go through lib/ntfy.mjs.
 *
 * Delivery is best-effort: publish failures throw to the caller (CLI) or are
 * swallowed by hooks; there is no outbox or retry (read receipts: lib/receipts.mjs).
 */
import { MAX_BODY_CHARS, NTFY_MESSAGE_MAX_BYTES, SESSION_LABEL, isGithubLogin, isValidName, statusTopic, inboxTopic, broadcastTopic } from "./config.mjs";
import { publish, pollCached, querySafe } from "./ntfy.mjs";
import { parsePhoneReply, parseQuestionText } from "./questions.mjs";
import { readState, writeState, statePath, withLock } from "./state.mjs";
import { parseMode, recordMode } from "./mode.mjs";
import { readAttachment } from "./attachment.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const INITIAL_LOOKBACK_S = 3600; // first contact: deliver messages from the last hour
export const MAX_PER_CLAIM = 20;
const SEEN_MAX = 500;
export { NTFY_MESSAGE_MAX_BYTES };
const HARNESSES = new Set(["claude", "codex", "cursor", "opencode"]);
const MESSAGE_ID = /^[a-zA-Z0-9-]{1,64}$/;
// States of a respond envelope (a msg with replyTo); old clients ignore the field.
export const RESPOND_STATES = ["working", "reply", "done", "declined"];

function envelope(cfg, kind, fields) {
  return JSON.stringify({ v: 1, kind, from: cfg.peer, ...(cfg.session ? { session: cfg.session } : {}), ...fields });
}

export function parseEnvelope(raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return null; }
  return m && typeof m === "object" && m.v === 1 ? m : null;
}

/** Status carries metadata only: peer, event, harness, time. No paths, prompts, or output. */
export async function publishStatus(cfg, { event, harness }) {
  const h = HARNESSES.has(harness) ? harness : "other";
  const msg = envelope(cfg, "status", { event, harness: h, ...(cfg.parent ? { parent: cfg.parent } : {}), ts: new Date().toISOString() });
  await publish(cfg, statusTopic(cfg.project), msg, { title: "ai-collab status" });
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
 */
export async function sendMessage(cfg, target, body, { operatorThread, replyTo, attachment, urgent, state, by, mentionedIn, forSubagent, forTeam } = {}) {
  if (!cfg.enabled) throw new Error(`disabled: ${cfg.reason}`);
  const [peer, session, ...extra] = String(target).split("#");
  if (!isValidName(peer) || extra.length || (session !== undefined && (peer === "all" || !SESSION_LABEL.test(session)))) {
    throw new Error(`invalid peer name "${target}"`);
  }
  if (peer !== "all" && cfg.peers.length && !cfg.peers.includes(peer)) {
    throw new Error(`peer "${target}" is not in AI_COLLAB_PEERS`);
  }
  if (typeof body !== "string" || !body.trim()) throw new Error("empty message");
  if (body.length > MAX_BODY_CHARS) throw new Error(`message is over ${MAX_BODY_CHARS} characters`);
  const topic = peer === "all" ? broadcastTopic(cfg.project) : inboxTopic(cfg.project, peer);
  if (operatorThread && (cfg.peer !== "operator" || !session)) throw new Error("Direct chats require a session");
  if (replyTo !== undefined && !MESSAGE_ID.test(replyTo)) throw new Error("invalid reply_to message ID");
  if (state !== undefined && (!RESPOND_STATES.includes(state) || !replyTo)) throw new Error("state must be working, reply, done or declined, with reply_to");
  if (by !== undefined && (cfg.peer !== "operator" || !isGithubLogin(by))) throw new Error("by must be a GitHub login on an operator message");
  if (mentionedIn !== undefined && !MENTIONED_IN.test(mentionedIn)) throw new Error("invalid mentionedIn chat");
  if (forSubagent !== undefined && !SUBAGENT_RUN.test(forSubagent)) throw new Error("invalid forSubagent run ID");
  if (forTeam !== undefined && !TEAM_NAME.test(forTeam)) throw new Error("invalid forTeam name");
  const sent = await sendEnvelope(cfg, topic, {
    to: peer, ...(session ? { toSession: session } : {}), ts: new Date().toISOString(), body,
    ...(operatorThread ? { operatorThread: true } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(state ? { state } : {}),
    ...(urgent === true ? { urgent: true } : {}),
    ...(by ? { by } : {}),
    ...(mentionedIn ? { mentionedIn } : {}),
    ...(forSubagent ? { forSubagent } : {}),
    ...(forTeam ? { forTeam } : {}),
  }, { attachment });
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

async function sendEnvelope(cfg, topic, fields, { attachment } = {}) {
  const msg = envelope(cfg, "msg", fields);
  // With an attachment the message travels in the query string, respelled by querySafe.
  if (Buffer.byteLength(attachment === undefined ? msg : querySafe(msg)) > NTFY_MESSAGE_MAX_BYTES) {
    throw new Error(`encoded message exceeds ntfy’s ${NTFY_MESSAGE_MAX_BYTES}-byte limit`);
  }
  const attach = attachment === undefined ? undefined : readAttachment(attachment);
  const id = await publish(cfg, topic, msg, { title: `ai-collab from ${cfg.session ? `${cfg.peer}#${cfg.session}` : cfg.peer}`, attach });
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

/**
 * Read new messages for this peer (direct inbox plus broadcast).
 * - throttle: skip the network if the last poll was < pollIntervalMs ago (hot hooks), unless an urgent marker is newer.
 * - commit: false = peek, no cursor or dedup writes.
 * - strict: rethrow errors and lock contention instead of returning [] (CLI).
 * Cursors advance only past events that were processed, so a cap or failure
 * leaves the remainder for the next claim.
 */
export async function claimInbox(cfg, opts = {}) {
  const { now = Date.now(), throttle = false, commit = true, strict = false, limit = MAX_PER_CLAIM } = opts;
  if (!cfg.enabled) return [];
  const file = statePath(cfg);
  const inbox = inboxTopic(cfg.project, cfg.peer);
  const all = broadcastTopic(cfg.project);

  const run = async () => {
    const state = readState(file);
    if (throttle && cfg.pollIntervalMs > 0 && now - state.lastPollAt < cfg.pollIntervalMs && !urgentSince(cfg, state.lastPollAt)) return [];
    if (commit) state.lastPollAt = now;
    const seen = new Set(state.seen);
    const out = [];
    let lastError = null;

    for (const topic of [inbox, all]) {
      if (out.length >= limit) break;
      const cur = state.topics[topic] && typeof state.topics[topic] === "object" ? state.topics[topic] : {};
      const since = typeof cur.id === "string" && cur.id
        ? cur.id
        : String(Math.floor(now / 1000) - INITIAL_LOOKBACK_S);
      let events;
      try {
        events = await pollCached(cfg, topic, since);
      } catch (err) {
        lastError = err;
        continue; // fail open per topic
      }
      for (const ev of events) {
        if (out.length >= limit) break;
        cur.id = ev.id;
        state.topics[topic] = cur;
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        const m = parseEnvelope(ev.message);
        if (!m && topic === all && ev.message.trim() && !parsePhoneReply(ev.message)) {
          const question = parseQuestionText(ev.message);
          if (question && cfg.session && question.sender === `${cfg.peer}#${cfg.session}`) continue; // own question
          out.push({
            id: ev.id, from: "ntfy", to: "all", ts: "", body: ev.message.slice(0, MAX_BODY_CHARS),
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
        const operatorThread = m.from === "operator" && m.operatorThread === true && Boolean(m.toSession);
        const operatorBroadcast = m.from === "operator" && topic === all;
        out.push({
          id: ev.id,
          from: senderSession ? `${m.from}#${senderSession}` : m.from,
          to: m.toSession ? `${m.to}#${m.toSession}` : m.to,
          ts: typeof m.ts === "string" && /^[\w:.+-]{1,40}$/.test(m.ts) ? m.ts : "",
          body: m.body.slice(0, MAX_BODY_CHARS),
          ...(operatorThread ? { operatorThread: true } : {}),
          ...(operatorBroadcast ? { operatorBroadcast: true } : {}),
          ...(typeof m.replyTo === "string" && MESSAGE_ID.test(m.replyTo) ? { replyTo: m.replyTo } : {}),
          ...(RESPOND_STATES.includes(m.state) ? { state: m.state } : {}),
          ...(m.urgent === true ? { urgent: true } : {}),
          ...(m.from === "operator" && isGithubLogin(m.by) ? { by: m.by } : {}),
          ...(m.from === "operator" && typeof m.mentionedIn === "string" && MENTIONED_IN.test(m.mentionedIn) ? { mentionedIn: m.mentionedIn } : {}),
          ...(m.from === "operator" && typeof m.forSubagent === "string" && SUBAGENT_RUN.test(m.forSubagent) ? { forSubagent: m.forSubagent } : {}),
          ...(m.from === "operator" && typeof m.forTeam === "string" && TEAM_NAME.test(m.forTeam) ? { forTeam: m.forTeam } : {}),
        });
      }
      state.topics[topic] = cur;
    }

    if (strict && lastError && out.length === 0) throw lastError;
    state.seen = [...seen].slice(-SEEN_MAX);
    if (commit) writeState(file, state);
    return out;
  };

  try {
    if (!commit) return await run();
    const r = await withLock(file, run);
    if (!r.locked) {
      if (strict) throw new Error("another ai-collab process holds the inbox lock; retry");
      return [];
    }
    return r.value;
  } catch (err) {
    if (strict) throw err;
    return [];
  }
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
