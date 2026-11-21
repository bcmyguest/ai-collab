/**
 * Human session names for the operator UI, recorded in the local registry.
 * Claude Code: hook input `session_title` (SessionStart, UserPromptSubmit; Claude 2.1.330 schema).
 * Codex: `thread_name` of the thread's newest line in $CODEX_HOME/session_index.jsonl.
 * Cursor exposes none; the UI falls back to the folder and the first prompt's words.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripControl } from "./format.mjs";

export const NAME_MAX = 80;
const INDEX_TAIL_BYTES = 256 * 1024;

/** A clean one-line name of at most NAME_MAX characters, or "". */
export function cleanName(value) {
  if (typeof value !== "string") return "";
  return stripControl(value).replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
}

// Last bytes of a file as text; "" when unreadable.
function tail(file, bytes) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The harness's own name for this session, or "". */
export function sessionName(host, msg = {}, env = process.env) {
  if (host === "claude") return cleanName(msg.session_title);
  if (host !== "codex" || typeof msg.session_id !== "string" || !msg.session_id) return "";
  const index = join(env.CODEX_HOME || join(env.HOME || homedir(), ".codex"), "session_index.jsonl");
  const lines = tail(index, INDEX_TAIL_BYTES).split("\n").reverse();
  for (const line of lines) {
    if (!line.includes(msg.session_id)) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.id === msg.session_id) return cleanName(entry.thread_name);
    } catch { /* partial first line */ }
  }
  return "";
}
