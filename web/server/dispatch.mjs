/**
 * Dispatcher in the UI server: pushes direct messages into Codex and OpenCode sessions that have no hook running.
 * Claude: a direct message goes to the session's messaging socket (lib/claude-socket.mjs) when the gate is open; otherwise
 * the waiter and hooks deliver it.
 * Codex: `codex queue --thread <id> --message <text> --resume`, only while the session is idle (lib/idle.mjs).
 * OpenCode: POST /api/session/<id>/prompt with delivery steer (urgent) or queue, and resume: true.
 * A pushed message is marked delivered, so the session's own hooks skip it. fyi and broadcast messages are never pushed.
 * A message sent with expectReply is redelivered when the target has not answered (respond or read receipt):
 * after REDELIVER_MS, at most MAX_ATTEMPTS attempts, until TTL_MS after the first one. Cursor stays hook-only.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { broadcastTopic, inboxTopic, receiptsTopic } from "../../lib/config.mjs";
import { claudeTarget, sendToClaude } from "../../lib/claude-socket.mjs";
import { nativeSessionId, harnessEnv } from "../../lib/controls.mjs";
import { formatInbox, identityLine } from "../../lib/format.mjs";
import { sessionIdleState } from "../../lib/idle.mjs";
import { claimInbox, markDelivered, parseEnvelope } from "../../lib/inbox.mjs";
import { pollCached } from "../../lib/ntfy.mjs";
import { opencodeRequest } from "../../lib/opencode-api.mjs";
import { readReceipts } from "../../lib/receipts.mjs";
import { listSessions } from "../../lib/sessions.mjs";
import { writeState } from "../../lib/state.mjs";

export const REDELIVER_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
export const TTL_MS = 24 * 3_600_000;
const TICK_MS = 5000;
const CLAIM_LIMIT = 4;
const ANSWERS_MAX = 5000;
const CODEX_TIMEOUT_MS = 30_000;
const PUSHED = new Set(["claude", "codex", "opencode"]);

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

// Runs a command and resolves its exit code (null on a spawn error or timeout).
function runCommand(file, args, { env }) {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: CODEX_TIMEOUT_MS, stdio: "ignore" }, (error) => resolve(error ? (typeof error.code === "number" ? error.code : null) : 0));
  });
}

/**
 * Builds the dispatcher. projects() returns the enabled project configs; run, opencode, idle, now and env are injectable.
 * tick() makes one pass over every project and resolves the delivery counts; start() runs it every TICK_MS.
 */
export function createDispatcher({
  projects, run = runCommand, opencode = opencodeRequest, idle = sessionIdleState, now = Date.now, env = process.env, claim = claimInbox,
  claude = sendToClaude,
} = {}) {
  let timer = null;
  let running = false;
  const reads = new Map();
  const answers = new Map();
  const cursors = new Map();

  // Delivers text to one session through its harness's API; true on success.
  async function push(session, text, { urgent }) {
    if (!nativeSessionId(session.harness, session.sessionId)) return false;
    if (session.harness === "claude") return await claude(session, { text, urgent }, { env });
    if (session.harness === "codex") {
      return await run("codex", ["queue", "--thread", session.sessionId, "--message", text, "--resume"], { env: harnessEnv() }) === 0;
    }
    const r = await opencode("POST", `/api/session/${encodeURIComponent(session.sessionId)}/prompt`, {
      body: { text, delivery: urgent ? "steer" : "queue", resume: true }, env,
    });
    return r.ok;
  }

  // The text a session receives: identity line plus the formatted messages.
  const textFor = (scfg, messages) => [identityLine(scfg), formatInbox(messages, { session: scfg.session })].filter(Boolean).join("\n");

  // Claude takes a socket message in any state, when its gate is open; Codex waits for an idle session; OpenCode takes a queued or steering prompt in any state.
  async function ready(session, active) {
    if (session.harness === "claude") return claudeTarget(session, { env }) !== null;
    if (session.harness === "opencode") return active !== null;
    return await idle(session, { env }) === "idle";
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
      const waiting = (await claim(scfg, { commit: false, limit: CLAIM_LIMIT }).catch(() => []))
        .filter((m) => m.priority !== "fyi" && m.from !== "ntfy" && m.to !== "all");
      if (!waiting.length) continue;
      if (!await push(session, textFor(scfg, waiting), { urgent: waiting.some((m) => m.urgent) })) continue;
      await markDelivered(scfg, waiting.map((m) => m.id)).catch(() => {});
      counts.delivered += waiting.length;
      for (const m of waiting) {
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
        } else if (due && session && await ready(session, active)) {
          const scfg = { ...cfg, peer: session.peer, session: session.session };
          const again = { ...e.message, attempt: e.attempts + 1, attempts: MAX_ATTEMPTS };
          if (await push(session, textFor(scfg, [again]), { urgent: again.urgent === true })) {
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
    if (running) return total;
    running = true;
    try {
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
    start() {
      if (!timer) timer = setInterval(() => void tick(), TICK_MS).unref();
    },
    close() {
      clearInterval(timer);
      timer = null;
    },
  };
}
