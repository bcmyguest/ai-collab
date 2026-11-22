/**
 * Current-context telemetry from harness-reported counters, read locally; only the session label and token count leave the host.
 * Claude: last assistant message usage in the transcript (input + cache_read + cache_creation).
 * Codex: last token_count event's info.last_token_usage.total_tokens and info.model_context_window in the rollout.
 * Cursor: preCompact hook's context_tokens. OpenCode: context_tokens from the plugin (last step's input + cache tokens).
 * Claude, Cursor and OpenCode report no window, so their window is null.
 * Per session, the .context.json state keeps the last tokens, window and time, and the instruction files Claude loaded
 * (InstructionsLoaded hook: file_path, memory_type, load_reason).
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { broadcastTopic } from "./config.mjs";
import { publish } from "./ntfy.mjs";
import { writeState, statePath, withLock } from "./state.mjs";

export const CONTEXT_ALERT_TOKENS = 200_000;
const TAIL_BYTES = 512 * 1024;
const CONTEXT_FILES_MAX = 50;
const MEMORY_TYPES = new Set(["User", "Project", "Local", "Managed"]);
const LOAD_REASONS = new Set(["session_start", "nested_traversal", "path_glob_match", "include", "compact"]);

function tailLines(file) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8").split("\n").reverse();
  } finally {
    closeSync(fd);
  }
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function contextStatePath(cfg) {
  return statePath(cfg).replace(/\.json$/, ".context.json");
}

/** {tokens, window} from the harness's last usage report; each is null when unknown. */
export function contextUsage(host, msg) {
  if (host === "cursor" || host === "opencode") return { tokens: count(msg.context_tokens), window: null };
  const none = { tokens: null, window: null };
  const file = msg.transcript_path;
  if (typeof file !== "string" || !file.endsWith(".jsonl")) return none;
  let lines;
  try { lines = tailLines(file); } catch { return none; }
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (host === "claude" && entry?.type === "assistant" && entry.message?.usage) {
      const u = entry.message.usage;
      const parts = [u.input_tokens, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0].map(count);
      return { tokens: parts.includes(null) ? null : parts.reduce((a, b) => a + b, 0), window: null };
    }
    if (host === "codex" && entry?.type === "event_msg" && entry.payload?.type === "token_count" && entry.payload.info) {
      return {
        tokens: count(entry.payload.info.last_token_usage?.total_tokens),
        window: count(entry.payload.info.model_context_window),
      };
    }
  }
  return none;
}

export function contextTokens(host, msg) {
  return contextUsage(host, msg).tokens;
}

/** Alert once per crossing above the threshold; a failed publish stays armed so the next sample retries; ≤ threshold re-arms. */
export async function reportContext(cfg, tokens, { send = publish, window = null } = {}) {
  if (!cfg.enabled || !cfg.session || tokens === null) return { alerted: false };
  const file = contextStatePath(cfg);
  const result = await withLock(file, async () => {
    let state = {};
    try { state = JSON.parse(readFileSync(file, "utf8")); } catch { /* missing: armed */ }
    // The file is rewritten only when the tokens or window change; contextAt is the time of that change.
    if (state.contextTokens !== tokens || state.contextWindow !== window) {
      state.contextTokens = tokens;
      state.contextWindow = window;
      state.contextAt = Date.now();
      writeState(file, state);
    }
    const armed = state.contextAlertArmed !== false;
    if (tokens <= CONTEXT_ALERT_TOKENS) {
      if (!armed) { state.contextAlertArmed = true; writeState(file, state); }
      return false;
    }
    if (!armed) return false;
    const who = `${cfg.peer}#${cfg.session}`;
    const message = JSON.stringify({ v: 1, kind: "alert", from: cfg.peer, session: cfg.session, contextTokens: tokens, threshold: CONTEXT_ALERT_TOKENS });
    await send(cfg, broadcastTopic(cfg.project), message, { title: `ai-collab: ${who} context ${tokens} tokens (> ${CONTEXT_ALERT_TOKENS})` });
    state.contextAlertArmed = false;
    writeState(file, state);
    return true;
  });
  return { alerted: Boolean(result.locked && result.value) };
}

/** Records one instruction file from the InstructionsLoaded hook; a later load of the same path replaces its entry. */
export async function recordInstructions(cfg, msg) {
  const { file_path: path, memory_type: memory, load_reason: load } = msg;
  if (!cfg.enabled || !cfg.session || typeof path !== "string" || !path.startsWith("/") || !MEMORY_TYPES.has(memory) || !LOAD_REASONS.has(load)) return false;
  const file = contextStatePath(cfg);
  const result = await withLock(file, async () => {
    let state = {};
    try { state = JSON.parse(readFileSync(file, "utf8")); } catch { /* missing: none loaded yet */ }
    // A compaction drops the files that were loaded on demand (nested or glob-matched) from the context; the rest reload.
    const onDemand = new Set(["nested_traversal", "path_glob_match"]);
    const kept = (Array.isArray(state.contextFiles) ? state.contextFiles : []).filter(entry => entry.path !== path);
    const others = load === "compact" ? kept.filter(entry => !onDemand.has(entry.load)) : kept;
    state.contextFiles = [...others, { path, memory, load, at: Date.now() }].slice(-CONTEXT_FILES_MAX);
    writeState(file, state);
    return true;
  });
  return Boolean(result.locked && result.value);
}

/** The session's context from its state file: {tokens, window, at, files}; absent parts are null or []. */
export function readContext(cfg) {
  const empty = { tokens: null, window: null, at: null, files: [] };
  if (!cfg.session) return empty;
  let state;
  try { state = JSON.parse(readFileSync(contextStatePath(cfg), "utf8")); } catch { return empty; }
  const files = Array.isArray(state.contextFiles) ? state.contextFiles.filter(entry => typeof entry?.path === "string") : [];
  return {
    tokens: count(state.contextTokens),
    window: count(state.contextWindow),
    at: Number.isFinite(state.contextAt) ? state.contextAt : null,
    files,
  };
}
