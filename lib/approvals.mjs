/**
 * Phone approvals: a permission prompt (or Claude's AskUserQuestion) turned into a question on the broadcast topic
 * that the operator answers from the UI or the ntfy app, only while AFK mode is on or quiet.
 * Contract: {v:1, kind:"approval", from, session, harness, id, tool, summary, questions?, expiresAt, ts} asks;
 * "reply <id> allow|deny" (or the answers as JSON, for a choice) answers; {v:1, kind:"approval-end", id, reason} closes.
 * No answer, AFK turned off by the operator, the hook being killed, or any failure returns no decision,
 * so the harness shows its own terminal prompt. Nothing here ever allows or denies on its own.
 */
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { NTFY_MESSAGE_MAX_BYTES, broadcastTopic } from "./config.mjs";
import { publish, streamEvents } from "./ntfy.mjs";
import { stripControl } from "./format.mjs";
import { currentMode, parseMode, storedMode } from "./mode.mjs";
import { parsePhoneReply } from "./questions.mjs";
import { sendReceipts } from "./receipts.mjs";
import { summarize } from "../web/lib/activity-rows.js";

export const APPROVAL_ID = /^[a-f0-9]{12}$/;
export const END_REASONS = ["allowed", "denied", "answered", "timeout", "afk-off", "cancelled"];
const SUMMARY_MAX = 300;
const TOOL_MAX = 128;
const QUESTION_MAX = 500;
const HEADER_MAX = 40;
const LABEL_MAX = 100;
const QUESTIONS_MAX = 4;
const OPTIONS_MAX = 6;
const ALLOW = /^(allow|approve|yes|y|ok)$/i;
const DENY = /^(deny|reject|no|n)$/i;
const END_TIMEOUT_MS = 1500;
const RETRY_MAX_MS = 30_000;
const DENY_MESSAGE = "The operator denied this from the AI Collab phone UI.";

const text = (value, max) => typeof value === "string" ? stripControl(value).slice(0, max) : "";

/** AskUserQuestion questions with every field type-checked and capped, or null when the shape is wrong. */
export function cleanQuestions(raw, { descriptionMax = 300, previewMax = 2000 } = {}) {
  if (!Array.isArray(raw) || !raw.length || raw.length > QUESTIONS_MAX) return null;
  const out = [];
  for (const q of raw) {
    if (!q || typeof q.question !== "string" || !q.question.trim() || !Array.isArray(q.options) || !q.options.length) return null;
    const options = q.options.slice(0, OPTIONS_MAX).map((o) => ({
      label: text(o?.label, LABEL_MAX),
      ...(descriptionMax && text(o?.description, descriptionMax) ? { description: text(o.description, descriptionMax) } : {}),
      ...(previewMax && text(o?.preview, previewMax) ? { preview: text(o.preview, previewMax) } : {}),
    }));
    if (options.some((o) => !o.label)) return null;
    out.push({ question: text(q.question, QUESTION_MAX), header: text(q.header, HEADER_MAX), multiSelect: q.multiSelect === true, options });
  }
  return out;
}

// Tool input as the one-line summary the Activity view shows; a command array is joined first.
function inputSummary(input) {
  if (input === undefined || input === null) return "";
  const value = input && typeof input === "object" && Array.isArray(input.command) ? { ...input, command: input.command.join(" ") } : input;
  return text(summarize(typeof value === "string" ? value : JSON.stringify(value)), SUMMARY_MAX);
}

/** The request a hook input asks the operator for: {tool, summary, input, questions?}, or null. */
export function approvalRequest(host, key, msg) {
  if (host === "cursor") {
    if (key === "beforeshellexecution" && typeof msg.command === "string") return { tool: "Shell", summary: inputSummary({ command: msg.command }), input: msg };
    if (key === "beforemcpexecution") return { tool: text(msg.tool_name, TOOL_MAX) || "MCP", summary: inputSummary(msg.tool_input), input: msg };
    return null;
  }
  if (key !== "permissionrequest" || typeof msg.tool_name !== "string") return null;
  const tool = text(msg.tool_name, TOOL_MAX);
  if (host === "claude" && tool === "AskUserQuestion") {
    const questions = cleanQuestions(msg.tool_input?.questions);
    return questions ? { tool, summary: text(questions[0].question, SUMMARY_MAX), input: msg.tool_input, questions } : null;
  }
  return { tool, summary: inputSummary(msg.tool_input), input: msg.tool_input };
}

/** The approval envelope within ntfy's limit: long choice previews and descriptions shrink first; null if it cannot fit. */
export function approvalMessage(cfg, host, req, { id, expiresAt, ts = new Date().toISOString() }) {
  const base = { v: 1, kind: "approval", from: cfg.peer, ...(cfg.session ? { session: cfg.session } : {}), harness: host, id, tool: req.tool, summary: req.summary, expiresAt, ts };
  const tries = req.questions ? [[300, 2000], [200, 400], [100, 0], [0, 0]] : [[0, 0]];
  for (const [descriptionMax, previewMax] of tries) {
    const questions = req.questions ? cleanQuestions(req.questions, { descriptionMax, previewMax }) : undefined;
    const message = JSON.stringify(questions ? { ...base, questions } : base);
    if (Buffer.byteLength(message) <= NTFY_MESSAGE_MAX_BYTES) return message;
  }
  return null;
}

// One option label matched case-insensitively, else the text itself (the "Other" answer).
function matchLabel(question, value) {
  const found = question.options.find((o) => o.label.toLowerCase() === value.trim().toLowerCase());
  return found ? found.label : value.trim();
}

/** Answers for a choice from a reply: JSON {question: answer}, or plain text for a single question; null when incomplete. */
export function parseChoice(questions, answer) {
  let map = null;
  try {
    const value = JSON.parse(answer);
    if (value && typeof value === "object" && !Array.isArray(value)) map = value;
  } catch { /* plain text */ }
  if (!map) {
    if (questions.length !== 1) return null;
    map = { [questions[0].question]: answer };
  }
  const answers = {};
  for (const q of questions) {
    const value = map[q.question];
    if (typeof value !== "string" || !value.trim()) return null;
    const parts = q.multiSelect ? value.split(",").filter((part) => part.trim()) : [value];
    answers[q.question] = parts.map((part) => matchLabel(q, part)).join(", ");
  }
  return answers;
}

/** A phone reply as a decision: {behavior:"allow"|"deny"} or {behavior:"allow", answers} for a choice; null when unusable. */
export function replyDecision(req, answer) {
  if (req.questions) {
    const answers = parseChoice(req.questions, answer);
    return answers ? { behavior: "allow", answers } : null;
  }
  if (ALLOW.test(answer.trim())) return { behavior: "allow" };
  if (DENY.test(answer.trim())) return { behavior: "deny" };
  return null;
}

/** Hook output for a decision; null means no decision (the harness's own prompt). */
export function approvalOutput(host, decision, req) {
  if (host === "cursor") {
    if (!decision) return { permission: "ask" };
    return decision.behavior === "allow"
      ? { permission: "allow", user_message: "Allowed from the AI Collab phone UI.", agent_message: "The operator allowed this from their phone." }
      : { permission: "deny", user_message: "Denied from the AI Collab phone UI.", agent_message: DENY_MESSAGE };
  }
  if (!decision) return {};
  let body = decision.behavior === "allow" ? { behavior: "allow" } : { behavior: "deny", message: DENY_MESSAGE };
  // Claude's AskUserQuestion takes the answers in updatedInput, next to the original questions.
  if (host === "claude" && decision.answers) body = { behavior: "allow", updatedInput: { ...req.input, answers: decision.answers } };
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: body } };
}

/**
 * Streams the broadcast topic until the reply for id, a mode-off envelope newer than baseTs, the deadline, or an abort. Returns {decision, messageId} or {reason}. Stream failures reconnect with backoff.
 */
async function waitForReply(cfg, req, { id, deadline, baseTs, signal, stream, startS }) {
  const ctrl = new AbortController();
  let reason = "timeout";
  const stop = (why) => { if (!ctrl.signal.aborted) { reason = why; ctrl.abort(); } };
  const timer = setTimeout(() => stop("timeout"), Math.max(0, deadline - Date.now()));
  const onAbort = () => stop("cancelled");
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) stop("cancelled");
  let since = String(startS);
  let backoff = cfg.stopPollMs;
  try {
    while (!ctrl.signal.aborted) {
      try {
        for await (const ev of stream(cfg, [broadcastTopic(cfg.project)], { since, signal: ctrl.signal, onOpen: () => { backoff = cfg.stopPollMs; } })) {
          since = ev.id;
          const mode = parseMode(ev.message);
          if (mode?.mode === "off" && mode.ts > baseTs) return { reason: "afk-off" };
          const reply = parsePhoneReply(ev.message);
          const decision = reply?.id === id ? replyDecision(req, reply.answer) : null;
          if (decision) return { decision, messageId: ev.id };
        }
      } catch { /* outage, idle timeout, or abort */ }
      if (ctrl.signal.aborted) break;
      await delay(backoff, undefined, { signal: ctrl.signal }).catch(() => {});
      backoff = Math.min(backoff * 2, RETRY_MAX_MS);
    }
    return { reason };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    ctrl.abort();
  }
}

/**
 * Asks the operator's phone about one permission request and returns the hook output.
 * Returns the no-decision output immediately when AFK mode is off, approvals are disabled, or the request is unknown.
 */
export async function decideApproval(cfg, {
  host, key, input = {}, signal, now = Date.now, stream = streamEvents, send = publish,
  mode = host === "cursor" ? storedMode : currentMode,
} = {}) {
  const none = approvalOutput(host, null);
  const req = approvalRequest(host, key, input);
  if (!cfg.enabled || !req || cfg.approvalS <= 0) return none;
  // Cursor fires this before every shell command, so it reads the mode recorded locally instead of polling ntfy.
  const base = await Promise.resolve(mode(cfg)).catch(() => ({ mode: "off", ts: 0 }));
  if (base.mode === "off") return none;
  const id = randomBytes(6).toString("hex");
  const t0 = now();
  const deadline = t0 + cfg.approvalS * 1000;
  const message = approvalMessage(cfg, host, req, { id, expiresAt: deadline });
  if (!message) return none;
  const sender = cfg.session ? `${cfg.peer}#${cfg.session}` : cfg.peer;
  const title = (req.questions ? `Question from ${sender}: ${req.summary}` : `Approve ${req.tool} for ${sender}: ${req.summary}`).slice(0, 200);
  try {
    await send(cfg, broadcastTopic(cfg.project), message, { title, priority: 4 });
  } catch {
    return none;
  }
  const result = await waitForReply(cfg, req, { id, deadline, baseTs: base.ts, signal, stream, startS: Math.floor(t0 / 1000) });
  if (result.messageId) sendReceipts(cfg, [result.messageId]);
  const reason = result.decision ? (req.questions ? "answered" : result.decision.behavior === "allow" ? "allowed" : "denied") : result.reason;
  const end = JSON.stringify({ v: 1, kind: "approval-end", from: cfg.peer, ...(cfg.session ? { session: cfg.session } : {}), id, reason, ts: new Date().toISOString() });
  await send(cfg, broadcastTopic(cfg.project), end, { title: `ai-collab approval ${reason}`, priority: 1, signal: AbortSignal.timeout(END_TIMEOUT_MS) }).catch(() => {});
  return result.decision ? approvalOutput(host, result.decision, req) : none;
}
