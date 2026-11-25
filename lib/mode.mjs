import { alertPriority, readAlertLevel } from "./alerts.mjs";
/**
 * Operator AFK mode: on (away), off (present, default), quiet (alerts and blocking questions only).
 * The ai-collab.mode event carries the mode, timestamp and optional GitHub login. Latest timestamp wins.
 * Sessions learn the mode from claimInbox (recorded in session state) and from one fetch at SessionStart.
 * A failed fetch is unknown, not off: off is what the topic says when its cached history holds no mode envelope.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { broadcastTopic, isGithubLogin, listProjects, loadConfig } from "./config.mjs";
import { pollCached, publish } from "./transport.mjs";
import { readState, statePath, withLock, writeState } from "./state.mjs";
import { encodeEnvelope, parseWireEnvelope } from "./agui.mjs";

export const MODES = ["on", "off", "quiet"];
export const DEFAULT_MODE = Object.freeze({ mode: "off", ts: 0 });
const HISTORY = "12h"; // policy window: a mode older than this no longer describes the operator
// The mode this machine last read for the project, beside its sessions, so a session with no record of its own knows it.
const PROJECT_MODE_FILE = "operator-mode.json";
export { MACHINE_PREFIXES, WAKE_ENV, WAKE_PROMPT, machinePrompt, operatorPrompt } from "./machine-prompt.mjs";

/** The mode envelope as {mode, ts}, or null for anything else. */
export function parseMode(raw) {
  const m = parseWireEnvelope(raw);
  if (m?.kind !== "mode" || m.from !== "operator") return null;
  if (!MODES.includes(m.mode) || !Number.isSafeInteger(m.ts) || m.ts < 0) return null;
  return { mode: m.mode, ts: m.ts };
}

/** Latest mode in a list of ntfy events (oldest first); a tie goes to the later event. */
export function latestMode(events, start = null) {
  let best = start;
  for (const ev of events) {
    const m = parseMode(ev.message);
    if (m && (!best || m.ts >= best.ts)) best = m;
  }
  return best;
}

/** Merge a mode into session state in place; returns true when it changed the state. */
export function recordMode(state, m) {
  if (!m || (state.mode && Number(state.mode.ts) > m.ts)) return false;
  if (state.mode?.mode === m.mode && state.mode?.ts === m.ts) return false;
  state.mode = { mode: m.mode, ts: m.ts };
  return true;
}

// A recorded mode as {mode, ts}, or null for anything else (missing, half-written, or an unknown mode name).
function validMode(m) {
  return m && MODES.includes(m.mode) && Number.isFinite(m.ts) ? { mode: m.mode, ts: m.ts } : null;
}

/** The newest of the given modes by ts, or null when none of them is one. */
function newestMode(...modes) {
  let best = null;
  for (const cand of modes) {
    const m = validMode(cand);
    if (m && (!best || m.ts > best.ts)) best = m;
  }
  return best;
}

function projectModeFile(cfg) {
  return path.join(cfg.stateDir, cfg.project, PROJECT_MODE_FILE);
}

/**
 * The last mode any session on this machine read for the project, or null when none has.
 * The topic keeps mode envelopes for 12 hours, so a mode set earlier is gone from its cache; this record keeps it.
 */
export function projectMode(cfg) {
  try {
    return validMode(JSON.parse(readFileSync(projectModeFile(cfg), "utf8")));
  } catch {
    return null;
  }
}

/**
 * Records the mode this machine read for the project, for a later session whose own read fails.
 * Any successful read counts, including one that found no envelope (off, read at that moment); a failed read does not.
 */
export function saveProjectMode(cfg, m) {
  if (!validMode(m) || !(m.ts > 0)) return;
  const seen = projectMode(cfg);
  if (seen && seen.ts >= m.ts) return;
  try {
    writeState(projectModeFile(cfg), { mode: m.mode, ts: m.ts });
  } catch { /* no project record only costs the fallback */ }
}

/** The newest mode recorded for this session or for the project, without network; null when neither has one. */
export function recordedMode(cfg) {
  return newestMode(readState(statePath(cfg)).mode, projectMode(cfg));
}

/** Mode recorded locally for this session or peer, without network; a mode nothing recorded reads as the default off. */
export function storedMode(cfg) {
  return recordedMode(cfg) ?? { ...DEFAULT_MODE };
}

/**
 * The current mode, or null when this session cannot tell: the read failed and neither this session nor the project
 * records a mode. Null is not off — only a read of the topic, or the local record of one, may say off.
 */
export async function currentModeKnown(cfg, { poll = pollCached } = {}) {
  if (!cfg.enabled) return null;
  let read;
  try {
    read = latestMode(await poll(cfg, broadcastTopic(cfg.project), HISTORY));
  } catch {
    // An unreachable topic says nothing about the mode: the last read on this machine stands, and no record is unknown.
    return recordedMode(cfg);
  }
  const file = statePath(cfg);
  const r = await withLock(file, () => {
    const state = readState(file);
    // A successful read is knowledge: with no envelope in the cached history the mode is off. That record carries
    // ts 0, so any real envelope outranks it, and the mode note announces the default once, as documented.
    if (recordMode(state, read ?? DEFAULT_MODE)) writeState(file, state);
    return validMode(state.mode) ?? { ...DEFAULT_MODE };
  }).catch(() => ({ locked: false }));
  const mode = (r.locked ? r.value : validMode(read)) ?? { ...DEFAULT_MODE };
  saveProjectMode(cfg, mode);
  return mode;
}

/** Fetch the latest mode from the broadcast topic, record it locally, and return it; unknown reads as the default off. */
export async function currentMode(cfg, opts = {}) {
  return (await currentModeKnown(cfg, opts)) ?? { ...DEFAULT_MODE };
}

/** Publish one mode envelope to each config's broadcast topic; by names the UI user. Returns per-project results; never throws. */
export async function publishMode(cfgs, mode, { now = Date.now(), send = publish, by } = {}) {
  if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(", ")}`);
  if (by !== undefined && !isGithubLogin(by)) throw new Error("by must be a GitHub login");
  const fields = { from: "operator", mode, ts: now, ...(by ? { by } : {}) };
  return Promise.all(cfgs.map(async (cfg) => {
    try {
      await send(cfg, broadcastTopic(cfg.project), encodeEnvelope("mode", fields, cfg.wire), { title: `ai-collab: operator AFK mode ${mode}`, priority: alertPriority(readAlertLevel(), "other") });
      return { project: cfg.project, ok: true };
    } catch (error) {
      return { project: cfg.project, ok: false, error: error.message };
    }
  }));
}


/** Operator configs for every project in projects.json; falls back to the environment's project. */
export function operatorConfigs(env = process.env) {
  const base = { ...env, AI_COLLAB_PEER: "operator" };
  const seen = new Set();
  const cfgs = [];
  for (const project of listProjects(env)) {
    const cfg = loadConfig(base, { cwd: project.root });
    const key = `${cfg.url} ${cfg.project}`;
    if (cfg.enabled && !seen.has(key)) {
      seen.add(key);
      cfgs.push(cfg);
    }
  }
  if (!cfgs.length) {
    const cfg = loadConfig(base);
    if (cfg.enabled) cfgs.push(cfg);
  }
  return cfgs;
}

/** One-line rules an agent follows in each mode. */
export function modeNote(mode, { session = "", afkWaitS = 600 } = {}) {
  const s = session ? `session=${JSON.stringify(session)}` : "your session label";
  const minutes = Math.round(afkWaitS / 60);
  switch (mode) {
    case "on":
      return "[ai-collab] Operator AFK mode is ON: the operator is away from the terminal. "
        + `At each milestone, post a one-line progress note with the ai-collab send_to_all tool (progress=true, ${s}). `
        + `Ask anything that needs the human with the ai-collab ask_question tool (${s}); set important=true only when you cannot continue without the answer. `
        + `To wait for the operator after your turn, call ask_question or the ai-collab wait_for_operator tool (${s}), then end your turn: the Stop hook waits up to ${minutes} min. `
        + "Otherwise your turn ends at once. An important question holds until it is answered.";
    case "quiet":
      return "[ai-collab] Operator AFK mode is QUIET: send no progress messages. "
        + `Use the ai-collab ask_question tool (${s}) only for blocking questions, with important=true; the Stop hook holds until they are answered. `
        + "Context alerts still go out automatically. Still answer operator messages.";
    default:
      return "[ai-collab] Operator AFK mode is OFF: the operator is at the terminal. Send no progress messages; answer operator messages as instructed.";
  }
}

/**
 * The mode note this session has not seen yet (or always, with force), marking it as seen.
 * The default (no envelope seen) counts as already announced. Returns "" when there is nothing new.
 * With no mode recorded for this session it falls back to the project's last known one, and with none at all it says
 * nothing: announcing OFF for an unread mode is what told headless sessions the operator was at the terminal.
 */
export async function takeModeNote(cfg, { force = false } = {}) {
  if (!cfg.enabled || !cfg.session) return "";
  const file = statePath(cfg);
  const r = await withLock(file, () => {
    const state = readState(file);
    // A mode this machine never read is unknown, and unknown must not be announced as off.
    const m = newestMode(state.mode, projectMode(cfg));
    if (!m) return "";
    if (!force && (state.modeNotedTs ?? 0) === m.ts) return "";
    state.modeNotedTs = m.ts;
    writeState(file, state);
    return modeNote(m.mode, { session: cfg.session, afkWaitS: cfg.afkWaitS });
  }).catch(() => ({ locked: false }));
  return r.locked ? r.value : "";
}
