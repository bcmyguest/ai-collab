// A session the operator started with an @tag runs headless and writes its output to a log file (lib/start.mjs). When it ends
// on a usage or plan limit with no reply, nothing else tells the operator: no runner owns it and the hooks never saw a reply.
// This reads that log with the same classifier the runner and hook use (lib/limits.mjs); it is not a second detector.
import { limitLine } from "./limit-alert.mjs";
import { limitFromRunError } from "./limits.mjs";

// Stream events that show the harness answered: a Codex agent message, a Cursor assistant event, an OpenCode text part.
function replied(event) {
  return event?.item?.type === "agent_message" || event?.type === "assistant" || event?.type === "text";
}

// The error text an event or plain line carries, or "".
function errorOf(event) {
  if (event?.type === "turn.failed") return String(event.error?.message ?? "");
  if (event?.type === "error") return String(event.message ?? event.error?.data?.message ?? event.error?.message ?? "");
  if (event?.type === "result" && event.is_error === true) return String(event.result ?? "");
  return "";
}

/**
 * What a started session's log says about how it ended: {replied, error}. JSON lines are stream events; any other line is text the
 * CLI printed to stderr (Cursor prints "ActionRequiredError: You've hit your usage limit ..." that way).
 */
export function readStartLog(text) {
  let answered = false;
  const errors = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { errors.push(line.trim()); continue; }
    if (replied(event)) answered = true;
    const error = errorOf(event);
    if (error) errors.push(error);
  }
  return { replied: answered, error: [...new Set(errors)].join("\n") };
}

/**
 * The system message for a tag-started session that ended on a limit with no reply, or null. tag is what the operator typed
 * ("@codex:gpt-6.2-sol"); the reset time is in the text only when the harness's error gave one.
 */
export function limitEndNotice({ tag, harness, model, log }) {
  const read = readStartLog(log);
  if (read.replied || !read.error) return null;
  const limit = limitFromRunError(harness, read.error);
  if (!limit) return null;
  return `${tag} ended without a reply: ${limitLine({ harness, model, windowName: limit.windowName, resetsAt: limit.resetsAt, wording: limit.wording })}.`;
}
