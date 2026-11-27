/**
 * Delivers a direct message into a running Claude Code session through its messaging socket, then confirms it.
 * The session record ~/.claude/sessions/<pid>.json carries messagingSocketPath while Claude's cross-session gate is on.
 * Frames are newline-delimited JSON: an auth frame with the peer token (<pid>.<hash>.key), then a user frame.
 * Every push uses priority "next", which lands after the current step, as hook delivery does mid-turn; "later" would queue
 * behind the whole turn while the push already counts as delivered at enqueue. Pulsar sends the same
 * frames (cli-sqgan6a2.js:3317-3380). The protocol is undocumented and may change between Claude releases.
 * Claude can still hold or drop a message, so delivery counts only when the transcript shows it (deliverToClaude).
 */
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, statSync, type Stats } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { isAbsolute, join } from "node:path";
import { isRunning } from "./process.ts";
// oxlint-disable-next-line typescript/no-explicit-any -- Claude session and socket JSON; each field is checked before use
type Json = any;

/** The registry fields a Claude push reads. */
export interface ClaudeSession {
  harness?: string;
  pid?: number;
  pidStart?: string;
  sessionId?: string;
}

export interface ClaudeTarget {
  socket: string;
  token: string;
  transcript: string;
}

export interface ClaudeSnapshot {
  transcript: string;
  fromSize: number;
}

export type ClaudePush =
  | { status: "delivered" | "unsent" }
  | { status: "unconfirmed"; watch: () => Promise<boolean>; confirmedSince: (id: string) => boolean };

const TIMEOUT_MS = 5000;
const CONFIRM_MS = 5000;
const WATCH_MS = 35000;
const CONFIRM_POLL_MS = 250;
const CHUNK_BYTES = 4 * 1024 * 1024;
const CWD_MAX = 200;
const MANAGED_DIR = "/etc/claude-code";
const NAME_UNSAFE = /["<>\n\r]/g;
const NAME_MAX = 120;
const TAG = /<\/?cross-session-message/gi;

/** Claude's config dir: CLAUDE_CONFIG_DIR, else ~/.claude under HOME. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
}

// A regular file or socket owned by uid, never a symlink; null otherwise.
function ownedEntry(file: string, uid: number, kind: "socket" | "file"): Stats | null {
  try {
    const st = lstatSync(file);
    if (st.uid !== uid) return null;
    return (kind === "socket" ? st.isSocket() : st.isFile()) ? st : null;
  } catch {
    return null;
  }
}

// The registry record for this pid, only when it is owned by us and its sessionId matches the registry entry.
function readRecord(dir: string, pid: number, sessionId: string | undefined, uid: number): Record<string, Json> | null {
  const file = join(dir, "sessions", `${pid}.json`);
  if (!ownedEntry(file, uid, "file")) return null;
  try {
    const rec = JSON.parse(readFileSync(file, "utf8"));
    return rec.sessionId === sessionId && (rec.pid === undefined || rec.pid === pid) ? rec : null;
  } catch {
    return null;
  }
}

// "accept", "missing" or "closed" for one settings file. An unreadable or unparsable file is closed, since its value is unknown.
function settingState(file: string): "accept" | "missing" | "closed" {
  let obj: Json;
  try {
    obj = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "closed";
  }
  if (!obj || typeof obj !== "object") return "closed";
  if (!("crossSessionInbound" in obj)) return "missing";
  return obj.crossSessionInbound === "accept" ? "accept" : "closed";
}

// Managed drop-ins: every *.json in managed-settings.d; an unreadable directory is returned as a path that stays closed.
function managedDropIns(): string[] {
  const dir = join(MANAGED_DIR, "managed-settings.d");
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f));
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? [] : [dir];
  }
}

/**
 * True only when the user's settings accept and no project, local or managed settings file holds
 * anything but accept (or cannot be read). Server-managed settings and --settings flags are not visible here.
 */
export function gateOpen(dir: string, cwd: unknown): boolean {
  if (settingState(join(dir, "settings.json")) !== "accept") return false;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return false;
  const files = [
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
    join(MANAGED_DIR, "managed-settings.json"),
    ...managedDropIns(),
  ];
  return files.every((file) => settingState(file) !== "closed");
}

// The single peer token for this pid; zero or several key files, or an unreadable one, give no token.
function peerToken(dir: string, pid: number, uid: number): string | null {
  const sessions = join(dir, "sessions");
  try {
    const files = readdirSync(sessions).filter((f) => f.startsWith(`${pid}.`) && f.endsWith(".key"));
    if (files.length !== 1) return null;
    const file = join(sessions, files[0]);
    if (!ownedEntry(file, uid, "file")) return null;
    return readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** The envelope Claude shows as "Another Claude session sent a message"; a body cannot close the tag early. */
export function claudeEnvelope(fromName: unknown, body: unknown): string {
  const name = String(fromName).replace(NAME_UNSAFE, "").slice(0, NAME_MAX);
  const safe = String(body).replace(TAG, "<cross_session_message");
  return `<cross-session-message from-name="${name}">\n${safe}\n</cross-session-message>`;
}

/** The newline-terminated frames for one message: auth (always, with a token), then the user frame. */
export function claudeFrames({ token, fromName, text }: { token?: string | null; fromName: unknown; text: unknown }): string {
  const lines: string[] = [];
  if (token) lines.push(JSON.stringify({ type: "auth", token }));
  lines.push(JSON.stringify({
    type: "user",
    message: { role: "user", content: claudeEnvelope(fromName, text) },
    priority: "next",
  }));
  return `${lines.join("\n")}\n`;
}

/**
 * The socket, token and transcript file for a registry session, or null when any check fails: not a Claude session,
 * the process (pid plus start tick) is gone, the gate is not open, the record or socket is not owned by this user or is a
 * symlink, the record's sessionId differs, or there is no single token file.
 */
export function claudeTarget(session: ClaudeSession, { env = process.env, uid = (process.getuid as () => number)() }: { env?: NodeJS.ProcessEnv; uid?: number } = {}): ClaudeTarget | null {
  if (session.harness !== "claude" || !Number.isInteger(session.pid) || typeof session.pidStart !== "string") return null;
  if (!isRunning({ pid: session.pid, start: session.pidStart })) return null;
  const dir = claudeConfigDir(env);
  const rec = readRecord(dir, session.pid as number, session.sessionId, uid);
  // Claude's record holds the launch cwd; the registry cwd follows the agent's shell and is not used here.
  const cwd = rec?.cwd;
  if (!gateOpen(dir, cwd)) return null;
  const socket = rec?.messagingSocketPath;
  if (typeof socket !== "string" || !isAbsolute(socket) || !ownedEntry(socket, uid, "socket")) return null;
  const token = peerToken(dir, session.pid as number, uid);
  if (!token) return null;
  const project = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (project.length > CWD_MAX) return null;
  return { socket, token, transcript: transcriptFile(dir, project, session.sessionId as string) };
}

// The session's transcript under its launch-cwd project dir; else the one under any project dir, or the launch-cwd path.
function transcriptFile(dir: string, project: string, sessionId: string): string {
  const file = join(dir, "projects", project, `${sessionId}.jsonl`);
  if (fileSize(file) > 0) return file;
  try {
    for (const p of readdirSync(join(dir, "projects"))) {
      const found = join(dir, "projects", p, `${sessionId}.jsonl`);
      if (fileSize(found) > 0) return found;
    }
  } catch {
    // no projects dir yet
  }
  return file;
}

// Writes the frames to a target socket; resolves true once they are flushed, false on any failure.
function writeFrames(target: ClaudeTarget, { fromName, text }: { fromName: unknown; text: unknown }): Promise<boolean> {
  const frames = claudeFrames({ token: target.token, fromName, text });
  return new Promise<boolean>((resolve) => {
    const socket = connect(target.socket);
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(TIMEOUT_MS, () => done(false));
    socket.on("error", () => done(false));
    socket.on("connect", () => {
      socket.write(frames, (err) => {
        if (err) return done(false);
        socket.end();
        done(true);
      });
    });
  });
}

// An environment number: the fallback when unset, empty, not finite, or below min.
function envMs(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

// The size of the transcript in bytes, 0 when it does not exist yet.
function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

// Every string value inside a parsed JSON value.

/**
 * True when the transcript bytes written after fromSize hold one cross-session envelope from fromName that contains
 * every id as "id=<id> ". Lines are parsed as JSON, so the envelope is matched in its decoded string value; bytes
 * before fromSize, which hold earlier deliveries, are never read.
 */
export function transcriptConfirms(file: string, fromSize: number, { ids, fromName }: { ids: string[]; fromName: unknown }): boolean {
  const header = `<cross-session-message from-name="${envelopeName(fromName)}">`;
  let size: number;
  let fd: number;
  try {
    size = statSync(file).size;
    if (size <= fromSize) return false;
    fd = openSync(file, "r");
  } catch {
    return false;
  }
  // Every byte after fromSize is read in CHUNK_BYTES steps; a line split across chunks is joined before it is parsed.
  const buf = Buffer.alloc(Math.min(CHUNK_BYTES, size - fromSize));
  let carry = Buffer.alloc(0);
  let pos = fromSize;
  try {
    while (pos < size) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const data = Buffer.concat([carry, buf.subarray(0, n)]);
      const cut = data.lastIndexOf(0x0a);
      if (cut < 0) {
        carry = data;
        continue;
      }
      if (lineConfirms(data.subarray(0, cut).toString("utf8"), header, ids)) return true;
      carry = data.subarray(cut + 1);
    }
    return lineConfirms(carry.toString("utf8"), header, ids);
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

// True when one of the newline-separated lines is an enqueue record whose content holds the header and every id.
function lineConfirms(text: string, header: string, ids: string[]): boolean {
  for (const line of text.split("\n")) {
    if (!line.includes("cross-session-message")) continue;
    let parsed: Json;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a partial line from a chunk still being written, or a non-JSON line
    }
    // Claude records an admitted message as {"type":"queue-operation","operation":"enqueue","content":"<cross-session-message ..."}.
    if (parsed?.type !== "queue-operation" || parsed.operation !== "enqueue" || typeof parsed.content !== "string") continue;
    if (parsed.content.startsWith(header) && ids.every((id) => parsed.content.includes(`id=${id} `))) return true;
  }
  return false;
}

/**
 * Delivers one message to a Claude session. Resolves {status}:
 * "delivered": the transcript shows every id after the write.
 * "unsent": no target, or the write failed. Nothing reached the session.
 * "unconfirmed": written, but not shown within the confirmation window. watch() resolves true if the transcript shows
 * it before the window (confirm plus AI_COLLAB_CLAUDE_WATCH_MS) ends, false otherwise. confirmedSince(id) checks the whole
 * range written after this push, so a caller re-sends only after it returns false.
 */
export async function deliverToClaude(session: ClaudeSession, { text, fromName = "ai-collab", ids }: { text: unknown; fromName?: unknown; ids?: unknown }, { env = process.env }: { env?: NodeJS.ProcessEnv } = {}): Promise<ClaudePush> {
  const target = claudeTarget(session, { env });
  if (!target || !Array.isArray(ids) || !ids.length) return { status: "unsent" };
  const fromSize = fileSize(target.transcript);
  if (!await writeFrames(target, { fromName, text })) return { status: "unsent" };
  const confirmMs = envMs(env, "AI_COLLAB_CLAUDE_CONFIRM_MS", CONFIRM_MS, 1);
  const windowEnd = Date.now() + confirmMs + envMs(env, "AI_COLLAB_CLAUDE_WATCH_MS", WATCH_MS, 0);
  const confirmed = (): boolean => transcriptConfirms(target.transcript, fromSize, { ids: ids as string[], fromName });
  const poll = async (until: number): Promise<boolean> => {
    for (;;) {
      if (confirmed()) return true;
      if (Date.now() >= until) return false;
      await delay(Math.min(CONFIRM_POLL_MS, Math.max(0, until - Date.now())));
    }
  };
  if (await poll(Math.min(windowEnd, Date.now() + confirmMs))) return { status: "delivered" };
  const confirmedSince = (id: string): boolean => transcriptConfirms(target.transcript, fromSize, { ids: [id], fromName });
  return { status: "unconfirmed", watch: () => poll(windowEnd), confirmedSince };
}

/** Milliseconds a Claude push is watched for confirmation: the confirm window plus the watch window. */
export function claudeWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  return envMs(env, "AI_COLLAB_CLAUDE_CONFIRM_MS", CONFIRM_MS, 1) + envMs(env, "AI_COLLAB_CLAUDE_WATCH_MS", WATCH_MS, 0);
}

/** The transcript size before a push, for claudeConfirmedSince; null when the session has no transcript. */
export function claudeSnapshot(session: ClaudeSession, { env = process.env }: { env?: NodeJS.ProcessEnv } = {}): ClaudeSnapshot | null {
  const target = claudeTarget(session, { env });
  return target ? { transcript: target.transcript, fromSize: fileSize(target.transcript) } : null;
}

/** Whether the transcript shows ids in the range written after snapshot; false without a snapshot. */
export function claudeConfirmedSince(snapshot: ClaudeSnapshot | null | undefined, ids: string[], fromName: unknown = "ai-collab"): boolean {
  return snapshot ? transcriptConfirms(snapshot.transcript, snapshot.fromSize, { ids, fromName }) : false;
}

// The envelope name Claude shows: quotes, angle brackets and newlines removed, capped.
function envelopeName(fromName: unknown): string {
  return String(fromName).replace(NAME_UNSAFE, "").slice(0, NAME_MAX);
}
