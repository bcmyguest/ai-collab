/**
 * Detects a prompt the operator queued in a session while its Stop hook waits in AFK mode.
 * - Claude Code appends {"type":"queue-operation","operation":"enqueue","content":"…"} to the transcript
 *   (Stop input transcript_path) when a typed or Remote Control prompt waits for the hook.
 * - Codex appends {"session_id","ts","text"} to $CODEX_HOME/history.jsonl when the user presses Enter.
 * Both formats are undocumented, so every failure means "nothing queued" (the wait goes on as before).
 * Only bytes appended after the watch starts are read; nothing from these files is published.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { operatorPrompt } from "./mode.mjs";
// oxlint-disable-next-line typescript/no-explicit-any -- transcript JSONL entries; each field is checked before use
type Json = any;

const READ_MAX_BYTES = 4 * 1024 * 1024;

type QueueCheck = () => boolean;
/** True when queued content came from the operator. */
export function queuedByOperator(content: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof content === "string" && operatorPrompt(content, env);
}

// Bytes [from, to) of the file as text.
function readRange(path: string, from: number, to: number): string {
  const fd = openSync(path, "r");
  try {
    const data = Buffer.alloc(to - from);
    const n = readSync(fd, data, 0, data.length, from);
    return data.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * check() that reads the complete JSON lines appended to path since the watch began and reports
 * whether any satisfies match(entry). Null when the file is unreadable now.
 */
function watchAppended(path: string, match: (entry: Record<string, Json>) => boolean): QueueCheck | null {
  let offset: number;
  try {
    offset = statSync(path).size;
  } catch {
    return null;
  }
  let partial = "";
  return () => {
    try {
      const size = statSync(path).size;
      if (size < offset) { offset = size; partial = ""; }
      if (size === offset) return false;
      let from = offset;
      if (size - from > READ_MAX_BYTES) { from = size - READ_MAX_BYTES; partial = ""; }
      const lines = (partial + readRange(path, from, size)).split("\n");
      offset = size;
      partial = lines.pop() as string;
      for (const line of lines) {
        let entry: Json;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry && typeof entry === "object" && match(entry)) return true;
      }
      return false;
    } catch {
      return false;
    }
  };
}

/**
 * For a Stop hook: a check() reporting whether the operator queued a prompt in this session since the watch began.
 * Claude reads transcript_path, Codex reads history.jsonl; other harnesses and unreadable files return null.
 */
export function watchQueue(host: string, input: { transcript_path?: unknown; session_id?: unknown } = {}, { env = process.env, now = Date.now }: { env?: NodeJS.ProcessEnv; now?: () => number } = {}): QueueCheck | null {
  if (host === "claude") {
    const path = input.transcript_path;
    if (typeof path !== "string" || !isAbsolute(path)) return null;
    return watchAppended(path, (e) => e.type === "queue-operation" && e.operation === "enqueue" && queuedByOperator(e.content, env));
  }
  if (host === "codex") {
    const session = input.session_id;
    if (typeof session !== "string" || !session) return null;
    const startS = Math.floor(now() / 1000);
    const home = env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
    return watchAppended(join(home, "history.jsonl"),
      (e) => e.session_id === session && Number(e.ts) >= startS && queuedByOperator(e.text, env));
  }
  return null;
}
