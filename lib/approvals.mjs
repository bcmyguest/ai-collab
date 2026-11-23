/**
 * Phone approvals: a permission prompt (or Claude's AskUserQuestion) turned into a question on the broadcast topic
 * that the operator answers from the UI or the ntfy app, only while AFK mode is on or quiet.
 * Claude's AskUserQuestion is asked in PreToolUse (decideQuestion): a phone answer returns permissionDecision "allow" with updatedInput.answers.
 * In mode off (Claude and Codex) the hook publishes the same fields as {kind:"approval-view", mode:"terminal"}, a view-only card, returns
 * no decision at once, and a later hook event of that session closes it with reason "terminal".
 * The ai-collab.approval event carries the card. "reply <id> allow|deny" or a choice answer replies.
 * The ai-collab.approval-end event closes both card types.
 * No answer, AFK turned off by the operator, the hook being killed, or any failure returns no decision,
 * so the harness shows its own terminal prompt. Nothing here ever allows or denies on its own.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { encodeEnvelope } from "./agui.mjs";
import { NTFY_MESSAGE_MAX_BYTES, broadcastTopic } from "./config.mjs";
import { publish, streamEvents } from "./ntfy.mjs";
import { deepLink } from "./deep-link.mjs";
import { alertPriority, readAlertLevel } from "./alerts.mjs";
import { stripControl } from "./format.mjs";
import { currentModeKnown, parseMode, storedMode } from "./mode.mjs";
import { parseChoice, parsePhoneReply } from "./questions.mjs";
import { sendReceipts } from "./receipts.mjs";
import { statePath, withLock, writeState } from "./state.mjs";
import { summarize } from "../web/lib/activity-rows.js";

export { parseChoice };

export const APPROVAL_ID = /^[a-f0-9]{12}$/;
export const END_REASONS = ["allowed", "denied", "answered", "timeout", "afk-off", "cancelled", "terminal"];
// Hosts whose terminal prompts get a view-only card in mode off, and the hook events that close it.
export const TERMINAL_HOSTS = new Set(["claude", "codex"]);
const TOOL_END_KEYS = new Set(["posttooluse", "posttoolusefailure"]);
const TURN_END_KEYS = new Set(["stop", "stopfailure", "userpromptsubmit", "sessionend"]);
const TERMINAL_OPEN_MAX = 20;
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
export function approvalMessage(cfg, host, req, { id, expiresAt, ts = new Date().toISOString(), view = false, owned = false }) {
  // A view-only card has its own kind, so readers that answer "approval" envelopes never offer Allow / Deny for it.
  const kind = view ? "approval-view" : "approval";
  const base = {
    ...(view ? { mode: "terminal" } : {}), from: cfg.peer, ...(cfg.session ? { session: cfg.session } : {}),
    harness: host, id, tool: req.tool, summary: req.summary, expiresAt, ts, ...(owned ? { owned: true } : {}),
  };
  const tries = req.questions ? [[300, 2000], [200, 400], [100, 0], [0, 0]] : [[0, 0]];
  for (const [descriptionMax, previewMax] of tries) {
    const questions = req.questions ? cleanQuestions(req.questions, { descriptionMax, previewMax }) : undefined;
    const message = encodeEnvelope(kind, questions ? { ...base, questions } : base, cfg.wire);
    if (Buffer.byteLength(message) <= NTFY_MESSAGE_MAX_BYTES) return message;
  }
  return null;
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

function terminalFile(cfg) {
  return statePath(cfg).replace(/\.json$/, ".terminal.json");
}

// This session's open view-only cards: [{id, tool, summary, expiresAt}].
function openTerminalCards(cfg) {
  try {
    const list = JSON.parse(readFileSync(terminalFile(cfg), "utf8")).open;
    return Array.isArray(list) ? list.filter((c) => APPROVAL_ID.test(c?.id) && typeof c.tool === "string" && typeof c.summary === "string" && Number.isFinite(c.expiresAt)) : [];
  } catch {
    return [];
  }
}

// Applies change to the open list under the lock and returns the cards it removed.
async function updateTerminalCards(cfg, change) {
  const file = terminalFile(cfg);
  const r = await withLock(file, () => {
    const before = openTerminalCards(cfg);
    const after = change(before).slice(-TERMINAL_OPEN_MAX);
    writeState(file, { open: after });
    return before.filter((c) => !after.some((a) => a.id === c.id));
  });
  return r.locked ? r.value : [];
}

const endMessage = (cfg, id, reason) => encodeEnvelope("approval-end", { from: cfg.peer, ...(cfg.session ? { session: cfg.session } : {}), id, reason, ts: new Date().toISOString() }, cfg.wire);

// Mode off: the card shows in the UI without answer buttons; the terminal prompt answers it.
async function publishTerminalCard(cfg, host, req, { now, send }) {
  if (!TERMINAL_HOSTS.has(host) || !cfg.session) return;
  const id = randomBytes(6).toString("hex");
  const expiresAt = now() + cfg.approvalS * 1000;
  const message = approvalMessage(cfg, host, req, { id, expiresAt, view: true });
  if (!message) return;
  const sender = `${cfg.peer}#${cfg.session}`;
  const title = (req.questions ? `Question in the terminal for ${sender}: ${req.summary}` : `${req.tool} waits in the terminal for ${sender}: ${req.summary}`).slice(0, 200);
  await send(cfg, broadcastTopic(cfg.project), message, { title, priority: alertPriority(readAlertLevel(), "question", 2), click: deepLink({ project: cfg.project }), signal: AbortSignal.timeout(END_TIMEOUT_MS) });
  const t = now();
  await updateTerminalCards(cfg, (open) => [...open.filter((c) => c.expiresAt > t), { id, tool: req.tool, summary: req.summary, expiresAt }]);
}

/**
 * Closes this session's view-only cards once the terminal prompt resolved: PostToolUse(Failure) closes the oldest card
 * with the same tool and summary; Stop, StopFailure, UserPromptSubmit and SessionEnd close them all. Returns the closed ids.
 */
export async function closeTerminalCards(cfg, { host, key, input = {}, send = publish } = {}) {
  if (!cfg.enabled || !cfg.session || !TERMINAL_HOSTS.has(host) || !(TOOL_END_KEYS.has(key) || TURN_END_KEYS.has(key))) return [];
  if (!openTerminalCards(cfg).length) return [];
  let match = () => true;
  if (TOOL_END_KEYS.has(key)) {
    const req = approvalRequest(host, "permissionrequest", input);
    if (!req) return [];
    match = (c) => c.tool === req.tool && c.summary === req.summary;
  }
  const closed = await updateTerminalCards(cfg, (open) => {
    if (TURN_END_KEYS.has(key)) return [];
    const hit = open.find(match);
    return open.filter((c) => c !== hit);
  }).catch(() => []);
  await Promise.all(closed.map((c) => send(cfg, broadcastTopic(cfg.project), endMessage(cfg, c.id, "terminal"),
    { title: "ai-collab approval terminal", priority: 1, signal: AbortSignal.timeout(END_TIMEOUT_MS) }).catch(() => {})));
  return closed.map((c) => c.id);
}

function askedFile(cfg) {
  return statePath(cfg).replace(/\.json$/, ".asked.json");
}

// Records the AskUserQuestion call the PreToolUse hook took, so its PermissionRequest posts no second card.
async function markAsked(cfg, toolUseId) {
  if (typeof toolUseId !== "string" || !toolUseId) return;
  const file = askedFile(cfg);
  await withLock(file, () => writeState(file, { toolUseId }));
}

function askedByPreTool(cfg, toolUseId) {
  if (typeof toolUseId !== "string" || !toolUseId) return false;
  try {
    return JSON.parse(readFileSync(askedFile(cfg), "utf8")).toolUseId === toolUseId;
  } catch {
    return false;
  }
}

/**
 * Posts the request as a card and waits for the phone reply, then posts its end envelope.
 * Returns {decision} when the phone answered, null when no card went out or nobody answered.
 */
async function phoneRound(cfg, host, req, { now, stream, send, signal, baseTs }) {
  const id = randomBytes(6).toString("hex");
  const t0 = now();
  const deadline = t0 + cfg.approvalS * 1000;
  const message = approvalMessage(cfg, host, req, { id, expiresAt: deadline });
  if (!message) return null;
  const sender = cfg.session ? `${cfg.peer}#${cfg.session}` : cfg.peer;
  const title = (req.questions ? `Question from ${sender}: ${req.summary}` : `Approve ${req.tool} for ${sender}: ${req.summary}`).slice(0, 200);
  try {
    await send(cfg, broadcastTopic(cfg.project), message, { title, priority: alertPriority(readAlertLevel(), "question", 4), click: deepLink({ project: cfg.project }) });
  } catch {
    return null;
  }
  const result = await waitForReply(cfg, req, { id, deadline, baseTs, signal, stream, startS: Math.floor(t0 / 1000) });
  if (result.messageId) sendReceipts(cfg, [result.messageId]);
  const reason = result.decision ? (req.questions ? "answered" : result.decision.behavior === "allow" ? "allowed" : "denied") : result.reason;
  await send(cfg, broadcastTopic(cfg.project), endMessage(cfg, id, reason), { title: `ai-collab approval ${reason}`, priority: 1, signal: AbortSignal.timeout(END_TIMEOUT_MS) }).catch(() => {});
  return result.decision ? { decision: result.decision } : null;
}

/**
 * Asks the operator's phone about one permission request and returns the hook output.
 * Returns the no-decision output immediately when approvals are disabled or the request is unknown, and when AFK mode
 * is off after publishing a view-only card (Claude and Codex). A mode that cannot be read is not off: only a reading
 * of off publishes the view-only card, so a headless session is never told the operator is at a terminal.
 */
export async function decideApproval(cfg, {
  host, key, input = {}, signal, now = Date.now, stream = streamEvents, send = publish,
  mode = host === "cursor" ? storedMode : currentModeKnown,
} = {}) {
  const none = approvalOutput(host, null);
  const req = approvalRequest(host, key, input);
  if (!cfg.enabled || !req || cfg.approvalS <= 0) return none;
  // The PreToolUse hook already put this AskUserQuestion on the phone (decideQuestion).
  if (req.questions && askedByPreTool(cfg, input.tool_use_id)) return none;
  // Cursor fires this before every shell command, so it reads the mode recorded locally instead of polling ntfy.
  // Cursor publishes no card either way (it is not a terminal host), so its default off claims nothing about AFK.
  const base = await Promise.resolve(mode(cfg)).catch(() => null);
  if (base?.mode === "off") {
    await publishTerminalCard(cfg, host, req, { now, send }).catch(() => {});
    return none;
  }
  // A null base is an unreadable mode: ask the phone, which is also what an unreadable publish makes a no-op.
  const outcome = await phoneRound(cfg, host, req, { now, stream, send, signal, baseTs: base?.ts ?? 0 });
  return outcome ? approvalOutput(host, outcome.decision, req) : none;
}

/**
 * PreToolUse for Claude's AskUserQuestion: the phone's answers come back as permissionDecision "allow" with
 * updatedInput.answers, which skips the terminal dialog. Returns {} (the terminal dialog) when no answer comes.
 * Mode off publishes a view-only card; the PostToolUse of the call closes it. As in decideApproval, only a mode read
 * as off publishes that card: an unreadable mode still asks the phone, so it never claims the operator is present.
 */
export async function decideQuestion(cfg, {
  host = "claude", input = {}, signal, now = Date.now, stream = streamEvents, send = publish, mode = currentModeKnown,
} = {}) {
  const req = approvalRequest(host, "permissionrequest", input);
  if (!cfg.enabled || !req?.questions || cfg.approvalS <= 0) return {};
  await markAsked(cfg, input.tool_use_id).catch(() => {});
  const base = await Promise.resolve(mode(cfg)).catch(() => null);
  if (base?.mode === "off") {
    await publishTerminalCard(cfg, host, req, { now, send }).catch(() => {});
    return {};
  }
  const outcome = await phoneRound(cfg, host, req, { now, stream, send, signal, baseTs: base?.ts ?? 0 });
  if (!outcome) return {};
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...input.tool_input, answers: outcome.decision.answers } } };
}
