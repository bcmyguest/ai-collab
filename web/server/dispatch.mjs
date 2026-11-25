/**
 * Dispatcher in the UI server: pushes direct messages into Codex, OpenCode and Claude sessions.
 * Claude: a direct message goes to the session's messaging socket (lib/claude-socket.mjs) when the gate is open, and counts
 * as delivered only once the transcript shows it. Otherwise the waiter and hooks deliver it.
 * Codex: `codex queue --thread <id> --message <text> --resume`, only while the session is idle (lib/idle.mjs).
 * OpenCode: POST /api/session/<id>/prompt with delivery steer (urgent) or queue, and resume: true.
 * A pushed message is reserved before the push and marked delivered after it, so the session's hooks and the waiter skip it.
 * A failed push releases the reservation and backs off per (session, message). fyi and broadcast messages are never pushed.
 * A message sent with expectReply is redelivered when the target has not answered (respond or read receipt):
 * after REDELIVER_MS, at most MAX_ATTEMPTS attempts, until TTL_MS after the first one. Cursor stays hook-only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { broadcastTopic, inboxTopic, receiptsTopic } from "../../lib/config.mjs";
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, MAX_ATTEMPTS, PUSHED, REDELIVER_MS, TTL_MS, direct, pushSession, readySession, runCommand } from "../../lib/deliver-push.mjs";
import { formatInbox } from "../../lib/format.mjs";
import { sessionIdleState } from "../../lib/idle.mjs";
import { claimInbox, ATTACHMENT_BUDGET_MS, markDelivered, parseEnvelope, releaseDelivery, reserveDelivery, reservedMessage } from "../../lib/inbox.mjs";
import { cacheAttachmentsWithin } from "../../lib/attachment-cache.mjs";
import { pollCached } from "../../lib/transport.mjs";
import { opencodeRequest } from "../../lib/opencode-api.mjs";
import { readReceipts } from "../../lib/receipts.mjs";
import { listSessions } from "../../lib/sessions.mjs";
import { writeState } from "../../lib/state.mjs";

export { MAX_ATTEMPTS, REDELIVER_MS, TTL_MS };
const TICK_MS = 5000;
const CLAIM_LIMIT = 4;
const ANSWERS_MAX = 5000;

function ledgerFile(cfg) {
  return join(cfg.stateDir, cfg.project, "dispatch.json");
}

function readLedger(cfg) {
  try {
    const s = JSON.parse(readFileSync(ledgerFile(cfg), "utf8"));
    return s.entries && typeof s.entries === "object" ? s.entries : {};
  } catch {
    return {};
  }
}

function writeLedger(cfg, entries) {
  writeState(ledgerFile(cfg), { entries });
}

/**
 * Builds the dispatcher. projects() returns the enabled project configs; run, opencode, idle, claude, claim, now and env
 * are injectable. tick() makes one pass over every project and resolves the delivery counts; start() runs it every TICK_MS;
 * drain() resolves once the background confirmations of unconfirmed Claude pushes have ended. skip() true makes a tick
 * do nothing (the runner delivers while it is up).
 */
export function createDispatcher({
  projects, run = runCommand, opencode = opencodeRequest, idle = sessionIdleState, now = Date.now, env = process.env, claim = claimInbox,
  claude = undefined, skip = () => false,
} = {}) {
  let timer = null;
  let running = false;
  const reads = new Map();
  const answers = new Map();
  const cursors = new Map();
  const backoff = new Map();
  // Per (session, id) of an unconfirmed push: whether the whole range written after that push holds the message.
  const rechecks = new Map();
  const watchers = new Set();

  const slot = (session, id) => `${session.id}\n${id}`;
  const cooling = (session, id) => (backoff.get(slot(session, id))?.nextAt ?? 0) > now();

  // Records a failed attempt for each id; the next attempt waits BACKOFF_BASE_MS doubling, up to BACKOFF_MAX_MS.
  function failed(session, ids) {
    for (const id of ids) {
      const failures = (backoff.get(slot(session, id))?.failures ?? 0) + 1;
      backoff.set(slot(session, id), { failures, nextAt: now() + Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS) });
    }
  }

  function forget(session, ids) {
    for (const id of ids) {
      backoff.delete(slot(session, id));
      rechecks.delete(slot(session, id));
    }
  }

  function pruneBackoff() {
    for (const [key, entry] of backoff) if (entry.nextAt < now() - TTL_MS) backoff.delete(key);
  }

  // Delivers text to one session through its harness's API. Resolves {status}: "delivered", "unsent" or "unconfirmed" (Claude only).
  function push(session, text, { urgent, ids }) {
    return pushSession(session, text, { urgent, ids }, { env, run, opencode, ...(claude ? { claude } : {}) });
  }

  // Keeps the reservation while a late confirmation is watched, then marks the messages delivered or releases them.
  // A release keeps a whole-range check per id, run before the message is pushed again.
  function watchLate(session, scfg, ids, result) {
    const job = result.watch()
      .then((ok) => {
        if (ok) return markDelivered(scfg, ids);
        for (const id of ids) rechecks.set(slot(session, id), () => result.confirmedSince?.(id) ?? false);
        return releaseDelivery(scfg, ids);
      })
      .catch(() => {})
      .finally(() => watchers.delete(job));
    watchers.add(job);
  }

  // Pushes reserved messages and settles the reservation. Resolves "delivered", "failed" or "pending" (watched).
  async function dispatchIds(session, scfg, text, { urgent, ids }) {
    const result = await push(session, text, { urgent, ids });
    if (result.status === "delivered") {
      await markDelivered(scfg, ids).catch(() => {});
      forget(session, ids);
      return "delivered";
    }
    failed(session, ids);
    if (result.status === "unconfirmed") {
      watchLate(session, scfg, ids, result);
      return "pending";
    }
    await releaseDelivery(scfg, ids).catch(() => {});
    return "failed";
  }

  // The text a session receives. An attachment is cached first, so the session reads this machine's copy
  // instead of downloading the file from the bus again. The sender-identity paragraph is SessionStart only.
  const textFor = async (scfg, messages) => {
    const shown = await cacheAttachmentsWithin(scfg, messages, { budgetMs: ATTACHMENT_BUDGET_MS });
    return formatInbox(shown, { session: scfg.session, peer: scfg.peer });
  };

  // Claude takes a socket message in any state, when its gate is open; Codex waits for an idle session; OpenCode takes a queued or steering prompt in any state.
  function ready(session, active) {
    return readySession(session, active, { env, idle });
  }

  // Folds new receipts and replies to this ledger's messages into reads and answers.
  async function refreshAcks(cfg, entries) {
    const topics = new Set([receiptsTopic(cfg.project), broadcastTopic(cfg.project)]);
    for (const e of Object.values(entries)) {
      topics.add(inboxTopic(cfg.project, e.address.split("#")[0]));
      if (e.from) topics.add(inboxTopic(cfg.project, e.from.split("#")[0]));
    }
    for (const topic of topics) {
      const key = `${cfg.project}\n${topic}`;
      let events;
      try { events = await pollCached(cfg, topic, cursors.get(key) || "all"); } catch { continue; }
      if (events.length) cursors.set(key, events.at(-1).id);
      if (topic === receiptsTopic(cfg.project)) { readReceipts(events, reads); continue; }
      for (const ev of events) {
        const m = parseEnvelope(ev.message);
        if (m?.kind !== "msg" || typeof m.replyTo !== "string" || typeof m.session !== "string") continue;
        if (!answers.has(m.replyTo)) answers.set(m.replyTo, new Set());
        answers.get(m.replyTo).add(`${m.from}#${m.session}`);
      }
    }
  }

  const acked = (id, address) => Boolean(reads.get(id)?.has(address) || answers.get(id)?.has(address));

  async function pushProject(cfg, active) {
    const counts = { delivered: 0, redelivered: 0, dropped: 0 };
    const entries = readLedger(cfg);
    const sessions = listSessions(cfg).filter((s) => PUSHED.has(s.harness) && s.online);
    for (const session of sessions) {
      if (!await ready(session, active)) continue;
      const scfg = { ...cfg, peer: session.peer, session: session.session };
      // The predicate runs before the cap: fyi, broadcasts and messages in backoff or reserved do not use up the claim.
      // A project-chat @mention is not pushed here. claimInbox and the runner deliver it to the session it names.
      const candidates = await claim(scfg, {
        commit: false, limit: CLAIM_LIMIT, accept: (m) => direct(m) && !cooling(session, m.id),
      }).catch(() => []);
      if (!candidates.length) continue;
      // Reserve before the push so the waiter's claim cannot take the same messages.
      const owned = new Set(await reserveDelivery(scfg, candidates.map((m) => m.id)));
      const waiting = candidates.filter((m) => owned.has(m.id)).map(m => reservedMessage(scfg, m)).filter(Boolean);
      if (!waiting.length) continue;
      // A message released after an unconfirmed push is checked over the whole range first: a late confirmation settles it.
      const late = waiting.filter((m) => rechecks.get(slot(session, m.id))?.());
      if (late.length) {
        await markDelivered(scfg, late.map((m) => m.id)).catch(() => {});
        for (const m of late) forget(session, [m.id]);
        counts.delivered += late.length;
      }
      const rest = waiting.filter((m) => !late.includes(m));
      if (!rest.length) continue;
      const ids = rest.map((m) => m.id);
      const status = await dispatchIds(session, scfg, await textFor(scfg, rest), { urgent: rest.some((m) => m.urgent), ids });
      if (status !== "delivered") continue;
      counts.delivered += rest.length;
      for (const m of rest) {
        if (m.expectReply) entries[m.id] = { address: session.id, from: m.from, firstAt: now(), lastAt: now(), attempts: 1, message: m };
      }
    }
    if (Object.keys(entries).length) {
      await refreshAcks(cfg, entries);
      for (const [id, e] of Object.entries(entries)) {
        const session = sessions.find((s) => s.id === e.address);
        const due = now() - e.lastAt >= REDELIVER_MS;
        if (acked(id, e.address) || now() - e.firstAt >= TTL_MS || (due && e.attempts >= MAX_ATTEMPTS)) {
          delete entries[id];
          counts.dropped += 1;
        } else if (due && session && !cooling(session, id) && await ready(session, active)) {
          const scfg = { ...cfg, peer: session.peer, session: session.session };
          const again = { ...e.message, attempt: e.attempts + 1, attempts: MAX_ATTEMPTS };
          // Redelivery reserves an id that is already seen, so the seen list can be trimmed without exposing it.
          const owned = await reserveDelivery(scfg, [id], { allowSeen: true });
          if (owned.length && await dispatchIds(session, scfg, await textFor(scfg, [again]), { urgent: again.urgent === true, ids: [id] }) === "delivered") {
            Object.assign(e, { lastAt: now(), attempts: e.attempts + 1 });
            counts.redelivered += 1;
          }
        }
      }
    }
    for (const id of answers.keys()) {
      if (answers.size <= ANSWERS_MAX) break;
      answers.delete(id);
    }
    writeLedger(cfg, entries);
    return counts;
  }

  async function tick() {
    const total = { delivered: 0, redelivered: 0, dropped: 0 };
    if (running || await Promise.resolve().then(skip).catch(() => false)) return total;
    running = true;
    try {
      pruneBackoff();
      const probe = await opencode("GET", "/api/session/active", { env });
      const active = probe.ok ? new Set(Object.keys(probe.body?.data ?? probe.body ?? {})) : null;
      for (const cfg of projects()) {
        if (!cfg.enabled) continue;
        const counts = await pushProject(cfg, active).catch(() => null);
        for (const key of Object.keys(total)) total[key] += counts?.[key] ?? 0;
      }
    } finally {
      running = false;
    }
    return total;
  }

  return {
    tick,
    drain() {
      return Promise.allSettled([...watchers]);
    },
    start() {
      if (!timer) timer = setInterval(() => void tick(), TICK_MS).unref();
    },
    close() {
      clearInterval(timer);
      timer = null;
    },
  };
}
