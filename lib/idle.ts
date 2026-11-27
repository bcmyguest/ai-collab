/**
 * Idle signal per harness, for `wait idle:<address>` and the dispatcher.
 * Claude: the status in ~/.claude/sessions/<pid>.json. OpenCode: /api/session/active. Codex and Cursor expose none
 * to outside processes, so the last hook event the registry recorded decides: Stop (or a start or end) means idle.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activeOpencodeSessions } from "./opencode-api.ts";

const IDLE_EVENTS = new Set(["Stop", "SessionStart", "SessionEnd"]);

export type IdleState = "idle" | "busy" | "unknown";

/** The registry fields the idle check reads. */
export interface IdleSession {
  harness?: string;
  pid?: number;
  sessionId?: string;
  event?: string;
  runningJobs?: number;
}

export interface IdleOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  active?: Set<string> | null;
  fetchFn?: typeof fetch;
}

function claudeStatus(session: IdleSession, home: string): IdleState {
  try {
    const s = JSON.parse(readFileSync(join(home, ".claude", "sessions", `${session.pid}.json`), "utf8"));
    if (s.sessionId !== session.sessionId || typeof s.status !== "string") return "unknown";
    return s.status === "idle" ? "idle" : "busy";
  } catch {
    return "unknown";
  }
}

/** "idle", "busy" or "unknown" for a registry session. active is a precomputed set of running OpenCode session ids. */
export async function sessionIdleState(session: IdleSession, { env = process.env, home = env.HOME || homedir(), active, fetchFn }: IdleOptions = {}): Promise<IdleState> {
  if ((session.runningJobs as number) > 0) return "busy";
  switch (session.harness) {
    case "claude": return Number.isInteger(session.pid) ? claudeStatus(session, home) : "unknown";
    case "opencode": {
      const ids = active === undefined ? await activeOpencodeSessions({ env, fetchFn }) : active;
      if (!ids) return "unknown";
      return ids.has(session.sessionId as string) ? "busy" : "idle";
    }
    case "codex":
    case "cursor":
      return IDLE_EVENTS.has(session.event as string) ? "idle" : "busy";
    default: return "unknown";
  }
}
