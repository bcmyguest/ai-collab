/**
 * Delivers a direct message into a running Claude Code session through its messaging socket, then confirms it.
 * The session record ~/.claude/sessions/<pid>.json carries messagingSocketPath while Claude's cross-session gate is on.
 * Frames are newline-delimited JSON: an auth frame with the peer token (<pid>.<hash>.key), then a user frame.
 * priority "next" lands after the current step (urgent); "later" queues behind the current turn. Pulsar sends the same
 * frames (cli-sqgan6a2.js:3317-3380). The protocol is undocumented and may change between Claude releases.
 * Claude can still hold or drop a message, so delivery counts only when the transcript shows it (deliverToClaude).
 */
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { isAbsolute, join } from "node:path";
import { isRunning } from "./process.mjs";

const TIMEOUT_MS = 5000;
const CONFIRM_MS = 5000;
const CONFIRM_POLL_MS = 250;
const TAIL_BYTES = 4 * 1024 * 1024;
const CWD_MAX = 200;
const MANAGED_DIR = "/etc/claude-code";
const NAME_UNSAFE = /["<>\n\r]/g;
const NAME_MAX = 120;
const TAG = /<\/?cross-session-message/gi;

/** Claude's config dir: CLAUDE_CONFIG_DIR, else ~/.claude under HOME. */
export function claudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
}

// A regular file or socket owned by uid, never a symlink; null otherwise.
function ownedEntry(file, uid, kind) {
  try {
    const st = lstatSync(file);
    if (st.uid !== uid) return null;
    return (kind === "socket" ? st.isSocket() : st.isFile()) ? st : null;
  } catch {
    return null;
  }
}

// The registry record for this pid, only when it is owned by us and its sessionId matches the registry entry.
function readRecord(dir, pid, sessionId, uid) {
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
function settingState(file) {
  let obj;
  try {
    obj = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return err.code === "ENOENT" ? "missing" : "closed";
  }
  if (!obj || typeof obj !== "object") return "closed";
  if (!("crossSessionInbound" in obj)) return "missing";
  return obj.crossSessionInbound === "accept" ? "accept" : "closed";
}

// Managed drop-ins: every *.json in managed-settings.d; an unreadable directory is returned as a path that stays closed.
function managedDropIns() {
  const dir = join(MANAGED_DIR, "managed-settings.d");
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f));
  } catch (err) {
    return err.code === "ENOENT" ? [] : [dir];
  }
}

/**
 * True only when the user's settings accept and no project, local or managed settings file holds
 * anything but accept (or cannot be read). Server-managed settings and --settings flags are not visible here.
 */
export function gateOpen(dir, cwd) {
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
function peerToken(dir, pid, uid) {
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
export function claudeEnvelope(fromName, body) {
  const name = String(fromName).replace(NAME_UNSAFE, "").slice(0, NAME_MAX);
  const safe = String(body).replace(TAG, "<cross_session_message");
  return `<cross-session-message from-name="${name}">\n${safe}\n</cross-session-message>`;
}

/** The newline-terminated frames for one message: auth (always, with a token), then the user frame. */
export function claudeFrames({ token, fromName, text, urgent }) {
  const lines = [];
  if (token) lines.push(JSON.stringify({ type: "auth", token }));
  lines.push(JSON.stringify({
    type: "user",
    message: { role: "user", content: claudeEnvelope(fromName, text) },
    priority: urgent ? "next" : "later",
  }));
  return `${lines.join("\n")}\n`;
}

/**
 * The socket, token and transcript file for a registry session, or null when any check fails: not a Claude session,
 * the process (pid plus start tick) is gone, the gate is not open, the record or socket is not owned by this user or is a
 * symlink, the record's sessionId differs, or there is no single token file.
 */
export function claudeTarget(session, { env = process.env, uid = process.getuid() } = {}) {
  if (session.harness !== "claude" || !Number.isInteger(session.pid) || typeof session.pidStart !== "string") return null;
  if (!isRunning({ pid: session.pid, start: session.pidStart })) return null;
  const dir = claudeConfigDir(env);
  if (!gateOpen(dir, session.cwd)) return null;
  const rec = readRecord(dir, session.pid, session.sessionId, uid);
  const socket = rec?.messagingSocketPath;
  if (typeof socket !== "string" || !isAbsolute(socket) || !ownedEntry(socket, uid, "socket")) return null;
  const token = peerToken(dir, session.pid, uid);
  if (!token) return null;
  const project = session.cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (project.length > CWD_MAX) return null;
  return { socket, token, transcript: join(dir, "projects", project, `${session.sessionId}.jsonl`) };
}

// Writes the frames to a target socket; resolves true once they are flushed, false on any failure.
function writeFrames(target, { fromName, text, urgent }) {
  const frames = claudeFrames({ token: target.token, fromName, text, urgent });
  return new Promise((resolve) => {
    const socket = connect(target.socket);
    let settled = false;
    const done = (ok) => {
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

/** Writes one message to the session's socket; resolves true once the frames are flushed (no confirmation). */
export function sendToClaude(session, { text, fromName = "ai-collab", urgent = false }, { env = process.env } = {}) {
  const target = claudeTarget(session, { env });
  return target ? writeFrames(target, { fromName, text, urgent }) : Promise.resolve(false);
}

/** True when the tail of the transcript holds a cross-session message line with every id. */
export function transcriptHas(file, ids) {
  let tail;
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buf, 0, buf.length, start);
    } finally {
      closeSync(fd);
    }
    tail = buf.toString("utf8");
  } catch {
    return false;
  }
  const lines = tail.split("\n").filter((line) => line.includes("cross-session-message"));
  return ids.every((id) => lines.some((line) => line.includes(`id=${id} `)));
}

/**
 * Delivers one message and confirms it: writes the frames, then polls the transcript until it shows every id
 * (CONFIRM_MS, or AI_COLLAB_CLAUDE_CONFIRM_MS). Resolves false when the write or the confirmation fails;
 * the caller then leaves the messages for the hooks.
 */
export async function deliverToClaude(session, { text, fromName = "ai-collab", urgent = false, ids }, { env = process.env } = {}) {
  const target = claudeTarget(session, { env });
  if (!target || !Array.isArray(ids) || !ids.length) return false;
  if (!await writeFrames(target, { fromName, text, urgent })) return false;
  const confirmMs = Number(env.AI_COLLAB_CLAUDE_CONFIRM_MS) >= 0 ? Number(env.AI_COLLAB_CLAUDE_CONFIRM_MS) : CONFIRM_MS;
  const deadline = Date.now() + confirmMs;
  for (;;) {
    if (transcriptHas(target.transcript, ids)) return true;
    if (Date.now() >= deadline) return false;
    await delay(CONFIRM_POLL_MS);
  }
}
