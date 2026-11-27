/**
 * Phone approvals: a permission prompt (or Claude's AskUserQuestion) turned into a question on the broadcast topic
 * that the operator answers from the UI or the ntfy app, only while AFK mode is on or quiet.
 * Claude's AskUserQuestion is asked in PreToolUse (decideQuestion): a phone answer returns permissionDecision "allow" with updatedInput.answers.
 * In mode off (Claude and Codex) the hook publishes the same fields as {kind:"approval-view", mode:"terminal"}, a view-only card, returns
 * no decision at once, and a later hook event of that session closes it with reason "terminal".
 * The ai-collab.approval event carries the card. "reply <id> allow|deny" or a choice answer replies.
 * The ai-collab.approval-end event closes both card types.
 * No answer, AFK turned off by the operator, an operator Skip, the hook being killed, or any failure returns no decision,
 * so the harness shows its own terminal prompt. Nothing here ever allows or denies on its own.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { broadcastTopic } from "./config.ts";
import { cleanQuestions, fitApprovalEnvelope, text, type CleanQuestion } from "./approval-card.ts";
import { publish, streamEvents, type Cfg } from "./messaging.ts";
import { deepLink } from "./deep-link.ts";
import { alertPriority, readAlertLevel } from "./alerts.ts";
import { currentModeKnown, storedMode } from "./mode.ts";
import { approvalEnd, parseChoice, waitForOperatorReply } from "./operator.ts";
import { sendReceipts } from "./receipts.ts";
import { statePath, withLock, writeState } from "./state.ts";
import { summarize } from "../web/lib/activity-rows.js";

export { cleanQuestions, parseChoice };

export const APPROVAL_ID = /^[a-f0-9]{12}$/;
// "skipped": the operator dismissed the card from the UI; the hook returns no decision, as on afk-off.
export const END_REASONS = ["allowed", "denied", "answered", "timeout", "afk-off", "cancelled", "terminal", "skipped"];
// Hosts whose terminal prompts get a view-only card in mode off, and the hook events that close it.
export const TERMINAL_HOSTS = new Set(["claude", "codex"]);
const TOOL_END_KEYS = new Set(["posttooluse", "posttoolusefailure"]);
const TURN_END_KEYS = new Set(["stop", "stopfailure", "userpromptsubmit", "sessionend"]);
const TERMINAL_OPEN_MAX = 20;
const SUMMARY_MAX = 300;
const TOOL_MAX = 128;
const ALLOW = /^(allow|approve|yes|y|ok)$/i;
const DENY = /^(deny|reject|no|n)$/i;
const END_TIMEOUT_MS = 1500;
const DENY_MESSAGE = "The operator denied this from the AI Collab phone UI.";

// oxlint-disable-next-line typescript/no-explicit-any -- hook input is harness JSON read field by field
type Json = any;
type Mode = ReturnType<typeof storedMode>;
type ModeRead = (cfg: Cfg) => Mode | null | Promise<Mode | null>;
type Send = typeof publish;
type Stream = typeof streamEvents;
export type ApprovalRequest = { tool: string; summary: string; input: Json; questions?: CleanQuestion[] };
export type Decision = { behavior: "allow" | "deny"; answers?: Record<string, string> };
type HookDecision = { behavior: string; message?: string; updatedInput?: Json };
type TerminalCard = { id: string; tool: string; summary: string; expiresAt: number };
export type ApprovalOptions = { host?: string; key?: string; input?: Json; signal?: AbortSignal; now?: () => number; stream?: Stream; send?: Send; mode?: ModeRead };

// Tool input as the one-line summary the Activity view shows; a command array is joined first.
function inputSummary(input: Json): string {
  if (input === undefined || input === null) return "";
  const value = input && typeof input === "object" && Array.isArray(input.command) ? { ...input, command: input.command.join(" ") } : input;
  return text(summarize(typeof value === "string" ? value : JSON.stringify(value)), SUMMARY_MAX);
}

/** The request a hook input asks the operator for: {tool, summary, input, questions?}, or null. */
export function approvalRequest(host: string | undefined, key: string | undefined, msg: Json): ApprovalRequest | null {
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

/** The approval envelope within ntfy's limit; null if it cannot fit. */
export function approvalMessage(cfg: Cfg, host: string, req: ApprovalRequest, { id, expiresAt, ts = new Date().toISOString(), view = false, owned = false }: { id: string; expiresAt: number; ts?: string; view?: boolean; owned?: boolean }): string | null {
  // A view-only card has its own kind, so readers that answer "approval" envelopes never offer Allow / Deny for it.
  const kind = view ? "approval-view" : "approval";
  const base = {
    ...(view ? { mode: "terminal" } : {}), from: cfg.peer, ...(cfg.session ? { session: cfg.session } : {}),
    harness: host, id, tool: req.tool, summary: req.summary, expiresAt, ts, ...(owned ? { owned: true } : {}),
  };
  return fitApprovalEnvelope(kind, base, req.questions, cfg.wire);
}

/** A phone reply as a decision: {behavior:"allow"|"deny"} or {behavior:"allow", answers} for a choice; null when unusable. */
export function replyDecision(req: { questions?: CleanQuestion[] }, answer: string): Decision | null {
  if (req.questions) {
    const answers = parseChoice(req.questions, answer);
    return answers ? { behavior: "allow", answers } : null;
  }
  if (ALLOW.test(answer.trim())) return { behavior: "allow" };
  if (DENY.test(answer.trim())) return { behavior: "deny" };
  return null;
}

/** Hook output for a decision; null means no decision (the harness's own prompt). */
export function approvalOutput(host: string | undefined, decision: Decision | null, req?: ApprovalRequest) {
  if (host === "cursor") {
    if (!decision) return { permission: "ask" };
    return decision.behavior === "allow"
      ? { permission: "allow", user_message: "Allowed from the AI Collab phone UI.", agent_message: "The operator allowed this from their phone." }
      : { permission: "deny", user_message: "Denied from the AI Collab phone UI.", agent_message: DENY_MESSAGE };
  }
  if (!decision) return {};
  let body: HookDecision = decision.behavior === "allow" ? { behavior: "allow" } : { behavior: "deny", message: DENY_MESSAGE };
  // Claude's AskUserQuestion takes the answers in updatedInput, next to the original questions.
  if (host === "claude" && decision.answers) body = { behavior: "allow", updatedInput: { ...(req as ApprovalRequest).input, answers: decision.answers } };
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: body } };
}

function terminalFile(cfg: Cfg): string {
  return statePath(cfg).replace(/\.json$/, ".terminal.json");
}

// This session's open view-only cards: [{id, tool, summary, expiresAt}].
function openTerminalCards(cfg: Cfg): TerminalCard[] {
  try {
    const list = JSON.parse(readFileSync(terminalFile(cfg), "utf8")).open;
    return Array.isArray(list) ? list.filter((c: Json) => APPROVAL_ID.test(c?.id) && typeof c.tool === "string" && typeof c.summary === "string" && Number.isFinite(c.expiresAt)) : [];
  } catch {
    return [];
  }
}

// Applies change to the open list under the lock and returns the cards it removed.
async function updateTerminalCards(cfg: Cfg, change: (open: TerminalCard[]) => TerminalCard[]): Promise<TerminalCard[]> {
  const file = terminalFile(cfg);
  const r = await withLock(file, async () => {
    const before = openTerminalCards(cfg);
    const after = change(before).slice(-TERMINAL_OPEN_MAX);
    writeState(file, { open: after });
    return before.filter((c) => !after.some((a) => a.id === c.id));
  });
  return r.locked ? r.value : [];
}

const endMessage = (cfg: Cfg, id: string, reason: string) => approvalEnd(cfg, id, reason, cfg.session ? { session: cfg.session } : {});

// Mode off: the card shows in the UI without answer buttons; the terminal prompt answers it.
async function publishTerminalCard(cfg: Cfg, host: string, req: ApprovalRequest, { now, send }: { now: () => number; send: Send }): Promise<void> {
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
export async function closeTerminalCards(cfg: Cfg, { host, key, input = {}, send = publish }: ApprovalOptions = {}): Promise<string[]> {
  if (!cfg.enabled || !cfg.session || !TERMINAL_HOSTS.has(host as string) || !(TOOL_END_KEYS.has(key as string) || TURN_END_KEYS.has(key as string))) return [];
  if (!openTerminalCards(cfg).length) return [];
  let match = (_c: TerminalCard) => true;
  if (TOOL_END_KEYS.has(key as string)) {
    const req = approvalRequest(host, "permissionrequest", input);
    if (!req) return [];
    match = (c) => c.tool === req.tool && c.summary === req.summary;
  }
  const closed = await updateTerminalCards(cfg, (open) => {
    if (TURN_END_KEYS.has(key as string)) return [];
    const hit = open.find(match);
    return open.filter((c) => c !== hit);
  }).catch((): TerminalCard[] => []);
  await Promise.all(closed.map((c) => send(cfg, broadcastTopic(cfg.project), endMessage(cfg, c.id, "terminal"),
    { title: "ai-collab approval terminal", priority: 1, signal: AbortSignal.timeout(END_TIMEOUT_MS) }).catch(() => {})));
  return closed.map((c) => c.id);
}

function askedFile(cfg: Cfg): string {
  return statePath(cfg).replace(/\.json$/, ".asked.json");
}

// Records the AskUserQuestion call the PreToolUse hook took, so its PermissionRequest posts no second card.
async function markAsked(cfg: Cfg, toolUseId: unknown): Promise<void> {
  if (typeof toolUseId !== "string" || !toolUseId) return;
  const file = askedFile(cfg);
  await withLock(file, async () => writeState(file, { toolUseId }));
}

function askedByPreTool(cfg: Cfg, toolUseId: unknown): boolean {
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
async function phoneRound(cfg: Cfg, host: string, req: ApprovalRequest, { now, stream, send, signal, baseTs }: { now: () => number; stream: Stream; send: Send; signal?: AbortSignal; baseTs: number }): Promise<{ decision: Decision } | null> {
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
  const outcome = await waitForOperatorReply({
    cfg, topic: broadcastTopic(cfg.project), id, deadline, signal, mode: "stream", since: String(Math.floor(t0 / 1000)),
    questions: req.questions, afterMode: baseTs, stream, read: (reply) => replyDecision(req, reply.answer),
  });
  const decision = outcome.status === "reply" ? outcome.value : null;
  if (decision) sendReceipts(cfg, [(outcome as { messageId: string }).messageId]);
  const reason = decision ? (req.questions ? "answered" : decision.behavior === "allow" ? "allowed" : "denied") : outcome.status;
  // The operator's Skip already closed the card.
  if (reason !== "skipped") await send(cfg, broadcastTopic(cfg.project), endMessage(cfg, id, reason), { title: `ai-collab approval ${reason}`, priority: 1, signal: AbortSignal.timeout(END_TIMEOUT_MS) }).catch(() => {});
  return decision ? { decision } : null;
}

/**
 * Asks the operator's phone about one permission request and returns the hook output.
 * Returns the no-decision output immediately when approvals are disabled or the request is unknown, and when AFK mode
 * is off after publishing a view-only card (Claude and Codex). A mode that cannot be read is not off: only a reading
 * of off publishes the view-only card, so a headless session is never told the operator is at a terminal.
 */
export async function decideApproval(cfg: Cfg, {
  host, key, input = {}, signal, now = Date.now, stream = streamEvents, send = publish,
  mode = host === "cursor" ? storedMode : currentModeKnown,
}: ApprovalOptions = {}) {
  const none = approvalOutput(host, null);
  const req = approvalRequest(host, key, input);
  if (!cfg.enabled || !req || cfg.approvalS <= 0) return none;
  // The PreToolUse hook already put this AskUserQuestion on the phone (decideQuestion).
  if (req.questions && askedByPreTool(cfg, input.tool_use_id)) return none;
  // Cursor fires this before every shell command, so it reads the mode recorded locally instead of polling ntfy.
  // Cursor publishes no card either way (it is not a terminal host), so its default off claims nothing about AFK.
  const base = await Promise.resolve(mode(cfg)).catch(() => null);
  if (base?.mode === "off") {
    await publishTerminalCard(cfg, host as string, req, { now, send }).catch(() => {});
    return none;
  }
  // A null base is an unreadable mode: ask the phone, which is also what an unreadable publish makes a no-op.
  const outcome = await phoneRound(cfg, host as string, req, { now, stream, send, signal, baseTs: base?.ts ?? 0 });
  return outcome ? approvalOutput(host, outcome.decision, req) : none;
}

/**
 * PreToolUse for Claude's AskUserQuestion: the phone's answers come back as permissionDecision "allow" with
 * updatedInput.answers, which skips the terminal dialog. Returns {} (the terminal dialog) when no answer comes.
 * Mode off publishes a view-only card; the PostToolUse of the call closes it. As in decideApproval, only a mode read
 * as off publishes that card: an unreadable mode still asks the phone, so it never claims the operator is present.
 */
export async function decideQuestion(cfg: Cfg, {
  host = "claude", input = {}, signal, now = Date.now, stream = streamEvents, send = publish, mode = currentModeKnown,
}: ApprovalOptions = {}) {
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
