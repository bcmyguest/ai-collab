/**
 * Current-context telemetry from harness-reported counters, read locally; only the session label and token count leave the host.
 * Claude: last assistant message usage in the transcript (input + cache_read + cache_creation).
 * Codex: last token_count event's info.last_token_usage.total_tokens in the rollout.
 * Cursor: preCompact hook's context_tokens. OpenCode: context_tokens from the plugin (last step's input + cache tokens).
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { encodeEnvelope } from "./agui.mjs";
import { broadcastTopic } from "./config.mjs";
import { publish } from "./ntfy.mjs";
import { writeState, statePath, withLock } from "./state.mjs";

export const CONTEXT_ALERT_TOKENS = 200_000;
const TAIL_BYTES = 512 * 1024;

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

export function contextTokens(host, msg) {
  if (host === "cursor" || host === "opencode") return count(msg.context_tokens);
  const file = msg.transcript_path;
  if (typeof file !== "string" || !file.endsWith(".jsonl")) return null;
  let lines;
  try { lines = tailLines(file); } catch { return null; }
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (host === "claude" && entry?.type === "assistant" && entry.message?.usage) {
      const u = entry.message.usage;
      const parts = [u.input_tokens, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0].map(count);
      return parts.includes(null) ? null : parts.reduce((a, b) => a + b, 0);
    }
    if (host === "codex" && entry?.type === "event_msg" && entry.payload?.type === "token_count" && entry.payload.info) {
      return count(entry.payload.info.last_token_usage?.total_tokens);
    }
  }
  return null;
}

/** Alert once per crossing above the threshold; a failed publish stays armed so the next sample retries; ≤ threshold re-arms. */
export async function reportContext(cfg, tokens, { send = publish } = {}) {
  if (!cfg.enabled || !cfg.session || tokens === null) return { alerted: false };
  const file = statePath(cfg).replace(/\.json$/, ".context.json");
  const result = await withLock(file, async () => {
    let state = {};
    try { state = JSON.parse(readFileSync(file, "utf8")); } catch { /* missing: armed */ }
    const armed = state.contextAlertArmed !== false;
    if (tokens <= CONTEXT_ALERT_TOKENS) {
      if (!armed) { state.contextAlertArmed = true; writeState(file, state); }
      return false;
    }
    if (!armed) return false;
    const who = `${cfg.peer}#${cfg.session}`;
    const message = encodeEnvelope("alert", { from: cfg.peer, session: cfg.session, contextTokens: tokens, threshold: CONTEXT_ALERT_TOKENS });
    await send(cfg, broadcastTopic(cfg.project), message, { title: `ai-collab: ${who} context ${tokens} tokens (> ${CONTEXT_ALERT_TOKENS})` });
    state.contextAlertArmed = false;
    writeState(file, state);
    return true;
  });
  return { alerted: Boolean(result.locked && result.value) };
}
