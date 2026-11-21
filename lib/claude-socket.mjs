/**
 * Pushes a direct message into a running Claude Code session through its messaging socket.
 * The session record ~/.claude/sessions/<pid>.json carries messagingSocketPath while Claude's cross-session gate is on.
 * Frames are newline-delimited JSON: an auth frame with the peer token (<pid>.<hash>.key) when present, then a user frame.
 * priority "next" lands after the current step (urgent); "later" queues behind the current turn. Pulsar sends the same
 * frames (cli-sqgan6a2.js:3317-3380). The protocol is undocumented and may change between Claude releases.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const TIMEOUT_MS = 5000;
const NAME_UNSAFE = /["<>\n\r]/g;
const NAME_MAX = 120;
const TAG = /<\/?cross-session-message/gi;

/** Claude's config dir: CLAUDE_CONFIG_DIR, else ~/.claude under HOME. */
export function claudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
}

// The registry record for this pid, only when its sessionId matches the registry entry (guards against pid reuse).
function readRecord(dir, pid, sessionId) {
  try {
    const rec = JSON.parse(readFileSync(join(dir, "sessions", `${pid}.json`), "utf8"));
    return rec.sessionId === sessionId ? rec : null;
  } catch {
    return null;
  }
}

// Claude's crossSessionInbound setting; anything but "accept" (hold, missing, unparsable) keeps messages on the hooks.
function inboundAccepted(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).crossSessionInbound === "accept";
  } catch {
    return false;
  }
}

// The absolute socket path from the record, only when it names an existing unix socket.
function socketOf(rec) {
  const path = rec.messagingSocketPath;
  if (typeof path !== "string" || !isAbsolute(path)) return null;
  try {
    return statSync(path).isSocket() ? path : null;
  } catch {
    return null;
  }
}

function peerToken(dir, pid) {
  try {
    const sessions = join(dir, "sessions");
    const file = readdirSync(sessions).find((f) => f.startsWith(`${pid}.`) && f.endsWith(".key"));
    return file ? readFileSync(join(sessions, file), "utf8").trim() : null;
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

/** The newline-terminated frames for one message: auth (when a token exists), then the user frame. */
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
 * The socket and token for a registry session, or null when it is not a Claude session, the gate is closed
 * (crossSessionInbound not "accept"), the record does not match, or the socket path is not a live unix socket.
 */
export function claudeTarget(session, { env = process.env } = {}) {
  if (session.harness !== "claude" || !Number.isInteger(session.pid)) return null;
  const dir = claudeConfigDir(env);
  if (!inboundAccepted(dir)) return null;
  const rec = readRecord(dir, session.pid, session.sessionId);
  const socket = rec && socketOf(rec);
  return socket ? { socket, token: peerToken(dir, session.pid) } : null;
}

/** Writes one message to the session's socket; resolves true once the frames are flushed, false on any failure. */
export function sendToClaude(session, { text, fromName = "ai-collab", urgent = false }, { env = process.env } = {}) {
  const target = claudeTarget(session, { env });
  if (!target) return Promise.resolve(false);
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
