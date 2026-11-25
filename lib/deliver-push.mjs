// Pushes one message into a live, non-owned session: Claude socket, Codex queue, OpenCode HTTP.
// Shared by the UI dispatcher (web/server/dispatch.mjs) and the runner's delivery workflows (runner/delivery.mjs).
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { receiptsTopic } from "./config.mjs";
import { claudeTarget, deliverToClaude } from "./claude-socket.mjs";
import { nativeSessionId, harnessEnv } from "./controls.mjs";
import { parseEnvelope } from "./inbox.mjs";
import { sessionIdleState } from "./idle.mjs";
import { pollCached } from "./transport.mjs";
import { opencodeRequest } from "./opencode-api.mjs";
import { readReceipts } from "./receipts.mjs";
import { argv } from "./harness.ts";
import { writeState } from "./state.mjs";

export const REDELIVER_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
export const TTL_MS = 24 * 3_600_000;
export const BACKOFF_BASE_MS = 5000;
export const BACKOFF_MAX_MS = 10 * 60_000;
export const PUSHED = new Set(["claude", "codex", "opencode"]);
const CODEX_TIMEOUT_MS = 30_000;

// A direct, non-broadcast message that is not fyi: the only kind pushed.
export const direct = (m) => m.priority !== "fyi" && m.from !== "ntfy" && m.to !== "all";

// Runs a command and resolves its exit code (null on a spawn error or timeout).
export function runCommand(file, args, { env }) {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: CODEX_TIMEOUT_MS, stdio: "ignore" }, (error) => resolve(error ? (typeof error.code === "number" ? error.code : null) : 0));
  });
}

/**
 * Delivers text through the session's harness API. Resolves {status}: "delivered", "unsent", or for Claude "unconfirmed"
 * with watch() and confirmedSince(id) (see lib/claude-socket.mjs deliverToClaude).
 */
export async function pushSession(session, text, { urgent, ids }, { env = process.env, run = runCommand, opencode = opencodeRequest, claude = deliverToClaude } = {}) {
  if (!nativeSessionId(session.harness, session.sessionId)) return { status: "unsent" };
  if (session.harness === "claude") return await claude(session, { text, urgent, ids }, { env });
  if (session.harness === "codex") {
    const [file, args] = argv("codex", "queue", { id: session.sessionId, text });
    const ok = await run(file, args, { env: harnessEnv() }) === 0;
    return { status: ok ? "delivered" : "unsent" };
  }
  const r = await opencode("POST", `/api/session/${encodeURIComponent(session.sessionId)}/prompt`, {
    body: { text, delivery: urgent ? "steer" : "queue", resume: true }, env,
  });
  return { status: r.ok ? "delivered" : "unsent" };
}

/**
 * Whether a session takes a push now. Claude takes a socket message in any state, when its gate is open; Codex waits for an
 * idle session; OpenCode takes a queued or steering prompt in any state (active is its active-session set, or null).
 */
export async function readySession(session, active, { env = process.env, idle = sessionIdleState } = {}) {
  if (session.harness === "claude") return claudeTarget(session, { env }) !== null;
  if (session.harness === "opencode") return active !== null;
  return await idle(session, { env }) === "idle";
}

// Whether a session still works on an earlier push: an OpenCode session with a running turn queues a new copy behind it.
export const busyWithPush = (session, active) => session.harness === "opencode" && Boolean(active?.has(session.sessionId));

/**
 * Read receipts and replies for delivered messages. refresh(cfg, topics) folds new events in; acked(id, address) is true
 * once the address read the message or answered it.
 */
export function ackTracker({ poll = pollCached } = {}) {
  const reads = new Map();
  const answers = new Map();
  const cursors = new Map();
  return {
    async refresh(cfg, topics) {
      for (const topic of topics) {
        const key = `${cfg.project}\n${topic}`;
        let events;
        try { events = await poll(cfg, topic, cursors.get(key) || "all"); } catch { continue; }
        if (events.length) cursors.set(key, events.at(-1).id);
        if (topic === receiptsTopic(cfg.project)) { readReceipts(events, reads); continue; }
        for (const ev of events) {
          const m = parseEnvelope(ev.message);
          if (m?.kind !== "msg" || typeof m.replyTo !== "string" || typeof m.session !== "string") continue;
          if (!answers.has(m.replyTo)) answers.set(m.replyTo, new Set());
          answers.get(m.replyTo).add(`${m.from}#${m.session}`);
        }
      }
    },
    acked: (id, address) => Boolean(reads.get(id)?.has(address) || answers.get(id)?.has(address)),
  };
}

// The UI dispatcher's ledger of expect-reply messages it delivered: {entries: {<msg id>: {address, firstAt, lastAt, attempts, message}}}.
export function dispatchLedgerFile(cfg) {
  return join(cfg.stateDir, cfg.project, "dispatch.json");
}

export function readDispatchLedger(cfg) {
  try {
    const entries = JSON.parse(readFileSync(dispatchLedgerFile(cfg), "utf8")).entries;
    return entries && typeof entries === "object" ? entries : {};
  } catch {
    return {};
  }
}

export function writeDispatchLedger(cfg, entries) {
  writeState(dispatchLedgerFile(cfg), { entries });
}
