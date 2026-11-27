// Pushes one message into a live, non-owned session: Claude socket, Codex queue, OpenCode HTTP.
// Shared by the UI dispatcher (web/server/dispatch.mjs) and the runner's delivery workflows (runner/delivery.mjs).
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { receiptsTopic } from "./config.mjs";
import { claudeTarget, deliverToClaude, type ClaudePush } from "./claude-socket.ts";
import { nativeSessionId, harnessEnv } from "./sessions/control.ts";
import { parseEnvelope, type Cfg, type TransportEvent } from "./messaging.ts";
import { sessionIdleState, type IdleState } from "./idle.ts";
import { pollCached } from "./messaging.ts";
import { opencodeRequest } from "./opencode-api.mjs";
import { readReceipts } from "./receipts.ts";
import { argv, type Command } from "./harness.ts";
import { writeState } from "./state.ts";
import { stopHookRunning } from "./stop.ts";

export const PUSHED = new Set(["claude", "codex", "opencode"]);
const CODEX_TIMEOUT_MS = 30_000;

// oxlint-disable-next-line typescript/no-explicit-any -- registry sessions and ledger entries are JSON read field by field
type Json = any;
export type PushStatus = ClaudePush | { status: "delivered" | "unsent" };
type Run = (file: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => Promise<number | null>;
type OpencodeRequest = (method: string, path: string, opts: { body: unknown; env?: NodeJS.ProcessEnv }) => Promise<{ ok: boolean }>;
export type PushDeps = { env?: NodeJS.ProcessEnv; run?: Run; opencode?: OpencodeRequest; claude?: typeof deliverToClaude };
type Poll = (cfg: Cfg, topic: string, since: string) => Promise<TransportEvent[]>;

// A direct, non-broadcast message that is not fyi: the only kind pushed.
export const direct = (m: { priority?: unknown; from?: unknown; to?: unknown }): boolean => m.priority !== "fyi" && m.from !== "ntfy" && m.to !== "all";

// Runs a command and resolves its exit code (null on a spawn error or timeout).
export function runCommand(file: string, args: string[], { env }: { env: NodeJS.ProcessEnv }): Promise<number | null> {
  return new Promise((resolve) => {
    // stdio is not in execFile's option types; a non-literal object passes it through unchanged.
    const options = { env, timeout: CODEX_TIMEOUT_MS, stdio: "ignore" };
    execFile(file, args, options, (error) => resolve(error ? (typeof error.code === "number" ? error.code : null) : 0));
  });
}

/**
 * Delivers text through the session's harness API. Resolves {status}: "delivered", "unsent", or for Claude "unconfirmed"
 * with watch() and confirmedSince(id) (see lib/claude-socket.ts deliverToClaude).
 */
export async function pushSession(session: Json, text: string, { urgent, ids }: { urgent?: boolean; ids?: unknown }, { env = process.env, run = runCommand, opencode = opencodeRequest, claude = deliverToClaude }: PushDeps = {}): Promise<PushStatus> {
  if (!nativeSessionId(session.harness, session.sessionId)) return { status: "unsent" };
  if (session.harness === "claude") return await claude(session, { text, ids }, { env });
  if (session.harness === "codex") {
    const [file, args] = argv("codex", "queue", { id: session.sessionId, text }) as Command;
    const ok = await run(file, args, { env: harnessEnv() }) === 0;
    return { status: ok ? "delivered" : "unsent" };
  }
  const r = await opencode("POST", `/api/session/${encodeURIComponent(session.sessionId)}/prompt`, {
    body: { text, delivery: urgent ? "steer" : "queue", resume: true }, env,
  });
  return { status: r.ok ? "delivered" : "unsent" };
}

/**
 * Whether a session takes a push now. Claude takes a socket message in any state, when its gate is open, except while its
 * Stop hook runs: a socket push then marks the message delivered and the hold never sees it (cfg: the project config).
 * Codex waits for an idle session; OpenCode takes a queued or steering prompt in any state (active is its active-session set, or null).
 */
// Whether a Claude session's Stop hook runs now: its hold delivers the messages, so a push waits (scfg: the session's config).
export const holdRunning = (session: { harness?: string }, scfg: Cfg): boolean => session.harness === "claude" && stopHookRunning(scfg);

export async function readySession(session: Json, active: Set<string> | null, { env = process.env, idle = sessionIdleState, cfg = null }: { env?: NodeJS.ProcessEnv; idle?: (session: Json, opts: { env: NodeJS.ProcessEnv }) => Promise<IdleState>; cfg?: Cfg | null } = {}): Promise<boolean> {
  if (session.harness === "claude") {
    if (cfg && holdRunning(session, { ...cfg, peer: session.peer, session: session.session })) return false;
    return claudeTarget(session, { env }) !== null;
  }
  if (session.harness === "opencode") return active !== null;
  return await idle(session, { env }) === "idle";
}

// Whether a session still works on an earlier push: an OpenCode session with a running turn queues a new copy behind it.
export const busyWithPush = (session: { harness?: string; sessionId?: string }, active: Set<string> | null | undefined): boolean => session.harness === "opencode" && Boolean(active?.has(session.sessionId as string));

/**
 * Read receipts and replies for delivered messages. refresh(cfg, topics) folds new events in; acked(id, address) is true
 * once the address read the message or answered it.
 */
export function ackTracker({ poll = pollCached }: { poll?: Poll } = {}) {
  const reads = new Map<string, Set<string>>();
  const answers = new Map<string, Set<string>>();
  const cursors = new Map<string, string>();
  return {
    async refresh(cfg: Cfg, topics: string[]): Promise<void> {
      for (const topic of topics) {
        const key = `${cfg.project}\n${topic}`;
        let events: TransportEvent[];
        try { events = await poll(cfg, topic, cursors.get(key) || "all"); } catch { continue; }
        if (events.length) cursors.set(key, (events.at(-1) as TransportEvent).id);
        if (topic === receiptsTopic(cfg.project)) { readReceipts(events, reads); continue; }
        for (const ev of events) {
          const m = parseEnvelope(ev.message);
          if (m?.kind !== "msg" || typeof m.replyTo !== "string" || typeof m.session !== "string") continue;
          if (!answers.has(m.replyTo)) answers.set(m.replyTo, new Set());
          (answers.get(m.replyTo) as Set<string>).add(`${m.from}#${m.session}`);
        }
      }
    },
    acked: (id: string, address: string) => Boolean(reads.get(id)?.has(address) || answers.get(id)?.has(address)),
  };
}

// The UI dispatcher's ledger of expect-reply messages it delivered: {entries: {<msg id>: {address, firstAt, lastAt, attempts, message}}}.
export function dispatchLedgerFile(cfg: Cfg): string {
  return join(cfg.stateDir, cfg.project, "dispatch.json");
}

export function readDispatchLedger(cfg: Cfg): Record<string, Json> {
  try {
    const entries = JSON.parse(readFileSync(dispatchLedgerFile(cfg), "utf8")).entries;
    return entries && typeof entries === "object" ? entries : {};
  } catch {
    return {};
  }
}

export function writeDispatchLedger(cfg: Cfg, entries: Record<string, Json>): void {
  writeState(dispatchLedgerFile(cfg), { entries });
}
