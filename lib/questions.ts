import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { parseWireEnvelope } from "./agui.ts";
import { fitApprovalEnvelope } from "./approval-card.ts";
import { MESSAGE_MAX_BYTES, SESSION_LABEL, broadcastTopic, isValidName } from "./config.ts";
import { assertWaitSeconds, choiceLabels, matchReply, waitForOperatorReply, type ChoiceQuestion, type Match, type PollFn } from "./operator.ts";
import { pollCached, publish, type Cfg } from "./messaging.ts";
import { deepLink } from "./deep-link.ts";
import { alertPriority, readAlertLevel } from "./alerts.ts";
import { sendReceipts } from "./receipts.ts";
import { statePath, withLock, writeState } from "./state.ts";

export { choiceLabels, parseChoice, parsePhoneReply, skippedQuestionId } from "./operator.ts";

const QUESTION_ID = /^[a-f0-9]{12}$/;
const MAX_QUESTION_BYTES = 2000;
const OPEN_MAX = 20;
const CHOICE_MIN = 2;
const CHOICE_MAX = 6;
const CHOICE_QUESTION_MAX = 500;
const LABEL_MAX = 100;
const DESCRIPTION_MAX = 300;

// oxlint-disable-next-line typescript/no-explicit-any -- the questions file and wire envelopes are JSON read back field by field
type Json = any;

export type ChoiceOption = { label: string; description?: string };
export type OpenQuestion = { id: string; important: boolean; askedAt: number; questions?: ChoiceQuestion[] };
export type ParsedQuestion = { sender: string; body: string; id: string; text: string };
export type Answer = { id: string; skipped: true } | { id: string; skipped?: false; answer: string; messageId: string };
export type AskOptions = {
  seconds?: number; important?: boolean; multiSelect?: boolean; choices?: unknown; harness?: string; now?: number;
  signal?: AbortSignal; intervalMs?: number;
};
export type AnswerResult = { id: string; status: string; answer?: string; selected?: string[]; source?: string; note?: string };

const QUESTION_TEXT = /^Question from ([^\n]+)\n\n([\s\S]+)\n\nReply in this topic: reply ([a-f0-9]{12}) YOUR ANSWER$/;

/** An agent's question and its human-readable reply instructions. */
export function parseQuestionText(raw: unknown): ParsedQuestion | null {
  const match = typeof raw === "string" && QUESTION_TEXT.exec(raw);
  if (match) return { sender: match[1], body: match[2], id: match[3], text: raw };
  const record: Json = parseWireEnvelope(raw);
  if (record?.kind !== "question" || !isValidName(record.from)) return null;
  const { from, session, id, body } = record;
  if (typeof id !== "string" || !QUESTION_ID.test(id) || typeof body !== "string" || !body.trim()) return null;
  if (session !== undefined && (typeof session !== "string" || !SESSION_LABEL.test(session))) return null;
  const sender = session ? `${from}#${session}` : from;
  return { sender, body, id, text: `Question from ${sender}\n\n${body}\n\nReply in this topic: reply ${id} YOUR ANSWER` };
}

// The ask_question options as choices, or null without options; throws on a shape the phone cannot show.
function validateChoices(question: string, options: unknown, multiSelect: boolean): ChoiceOption[] | null {
  if (options === undefined) {
    if (multiSelect) throw new Error("multi_select needs options");
    return null;
  }
  if (!Array.isArray(options) || options.length < CHOICE_MIN || options.length > CHOICE_MAX) {
    throw new Error(`Options must be an array of ${CHOICE_MIN} to ${CHOICE_MAX} choices`);
  }
  if (Array.from(question.trim()).length > CHOICE_QUESTION_MAX) throw new Error(`A question with options takes ${CHOICE_QUESTION_MAX} characters at most`);
  const seen = new Set<string>();
  return options.map((o: Json): ChoiceOption => {
    const label = typeof o?.label === "string" ? o.label.trim() : "";
    if (!label || label.length > LABEL_MAX) throw new Error(`Each option needs a label of 1 to ${LABEL_MAX} characters`);
    if (multiSelect && label.includes(",")) throw new Error("Option labels cannot contain commas when multi_select is true");
    if (seen.has(label.toLowerCase())) throw new Error(`Option labels must be unique: ${label}`);
    seen.add(label.toLowerCase());
    if (o.description !== undefined && (typeof o.description !== "string" || o.description.length > DESCRIPTION_MAX)) {
      throw new Error(`An option description takes ${DESCRIPTION_MAX} characters at most`);
    }
    return o.description ? { label, description: o.description.trim() } : { label };
  });
}

function questionsFile(cfg: Cfg): string {
  return statePath(cfg).replace(/\.json$/, ".questions.json");
}

/** Open questions this session asked: [{id, important, askedAt, questions?}], oldest first; questions are set for choice cards. */
export function openQuestions(cfg: Cfg): OpenQuestion[] {
  if (!cfg.session) return [];
  try {
    const list = JSON.parse(readFileSync(questionsFile(cfg), "utf8")).open;
    return Array.isArray(list)
      ? list.filter((q: Json) => QUESTION_ID.test(q?.id) && Number.isFinite(q.askedAt))
        .map(({ id, important, askedAt, questions }: Json): OpenQuestion => ({ id, important: important === true, askedAt, ...(Array.isArray(questions) ? { questions } : {}) }))
      : [];
  } catch {
    return [];
  }
}

async function updateQuestions(cfg: Cfg, change: (open: OpenQuestion[]) => OpenQuestion[]): Promise<void> {
  if (!cfg.session) return;
  const file = questionsFile(cfg);
  await withLock(file, async () => writeState(file, { open: change(openQuestions(cfg)).slice(-OPEN_MAX) }));
}

function waitFile(cfg: Cfg): string {
  return statePath(cfg).replace(/\.json$/, ".wait.json");
}

/** Ask the next Stop hook to wait for the operator (AFK mode ON); the Stop clears it when it ends or delivers. */
export async function requestWait(cfg: Cfg, now: number = Date.now(), questionId: string | null = null): Promise<void> {
  if (!cfg.session) return;
  const file = waitFile(cfg);
  await withLock(file, async () => writeState(file, { requestedAt: now, questionId }));
}

/** Time of this session's pending wait request, or 0. */
export function waitRequestedAt(cfg: Cfg): number {
  return Number(readWait(cfg)?.requestedAt) || 0;
}

function readWait(cfg: Cfg): Json {
  try { return JSON.parse(readFileSync(waitFile(cfg), "utf8")); } catch { return null; }
}

export async function clearWait(cfg: Cfg, questionId?: string): Promise<void> {
  if (!cfg.session || !waitRequestedAt(cfg)) return;
  const file = waitFile(cfg);
  await withLock(file, async () => {
    const pending = readWait(cfg);
    // Older wait records had no question ID.
    if (questionId === undefined || pending?.questionId === undefined || pending.questionId === questionId) {
      rmSync(file, { force: true });
    }
  }).catch(() => {});
}

export async function closeQuestion(cfg: Cfg, id: string): Promise<void> {
  await updateQuestions(cfg, (open) => open.filter((q) => q.id !== id));
  await clearWait(cfg, id);
}

// A reply as the text the agent reads: a choice as its labels joined "; ", a plain answer as typed.
function answerText(match: Match & { skipped: false }): string {
  return match.labels ? Object.values(match.labels).map((parts) => parts.join(", ")).join("; ") : match.answer;
}

/** Replies and skips on the broadcast topic for the given question IDs, since the oldest one was asked. */
export async function findAnswers(cfg: Cfg, questions: OpenQuestion[], { poll = pollCached }: { poll?: PollFn } = {}): Promise<Answer[]> {
  if (!questions.length) return [];
  const since = String(Math.floor(Math.min(...questions.map((q) => q.askedAt)) / 1000) - 60);
  const found = new Map<string, Answer>();
  for (const ev of await poll(cfg, broadcastTopic(cfg.project), since)) {
    for (const q of questions) {
      if (found.has(q.id)) continue;
      const match = matchReply(ev, { id: q.id, questions: q.questions });
      if (!match) continue;
      if (match.skipped) {
        found.set(q.id, { id: q.id, skipped: true });
      } else {
        const answer = answerText(match);
        if (answer) found.set(q.id, { id: q.id, answer, messageId: ev.id });
      }
      break;
    }
  }
  return [...found.values()];
}

/**
 * Asks the operator's phone. Options make a choice card (the approval envelope of lib/approvals.ts); the answer is the chosen labels.
 * Without options the phone gets a text question with a reply field.
 */
export async function askQuestion(cfg: Cfg, question: unknown, options: AskOptions = {}): Promise<AnswerResult> {
  assertWaitSeconds(options.seconds ?? 25);
  if (typeof question !== "string" || !question.trim() || Buffer.byteLength(question) > MAX_QUESTION_BYTES) {
    throw new Error("Question must contain 1–2000 UTF-8 bytes");
  }
  const id = randomBytes(6).toString("hex");
  const sender = cfg.session ? `${cfg.peer}#${cfg.session}` : cfg.peer;
  const topic = broadcastTopic(cfg.project);
  const important = options.important === true;
  const multiSelect = options.multiSelect === true;
  const choices = validateChoices(question, options.choices, multiSelect);
  const title = `${important ? "Important question" : "Question"} from ${sender}`;
  let questions: Array<ChoiceQuestion & { header: string }> | undefined, message: string | null;
  if (choices) {
    // Same envelope as a permission choice, so the UI renders the same card; expiresAt 0 keeps it open until answered.
    questions = [{ question: question.trim(), header: "", multiSelect, options: choices }];
    message = fitApprovalEnvelope("approval", {
      from: cfg.peer, ...(cfg.session ? { session: cfg.session } : {}), harness: options.harness || "other",
      id, tool: "ask_question", summary: question.trim(), expiresAt: 0, ts: new Date().toISOString(),
    }, questions, cfg.wire);
  } else {
    const body = (important ? "IMPORTANT, the agent waits for this answer: " : "") + question.trim();
    message = `Question from ${sender}\n\n${body}\n\nReply in this topic: reply ${id} YOUR ANSWER`;
  }
  if (!message || Buffer.byteLength(message) > MESSAGE_MAX_BYTES) throw new Error(`The question and its options exceed ${MESSAGE_MAX_BYTES} bytes`);
  await publish(cfg, topic, message, { title, click: deepLink({ project: cfg.project }), priority: alertPriority(readAlertLevel(), "question") });
  const askedAt = options.now ?? Date.now();
  await requestWait(cfg, askedAt, id).catch(() => {});
  await updateQuestions(cfg, (open) => [...open, { id, important, askedAt, ...(questions ? { questions } : {}) }]).catch(() => {});
  try {
    return await waitForAnswer(cfg, id, { ...options, questions });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return { id, status: "pending", note: "The question was published, but reading answers failed. Call wait_for_answer to retry." };
  }
}

export async function waitForAnswer(cfg: Cfg, id: unknown, { seconds = 25, signal, intervalMs = 4000, questions: known }: { seconds?: number; signal?: AbortSignal; intervalMs?: number; questions?: ChoiceQuestion[] } = {}): Promise<AnswerResult> {
  if (typeof id !== "string" || !QUESTION_ID.test(id)) throw new Error("Invalid question ID");
  assertWaitSeconds(seconds);
  const questions = known ?? openQuestions(cfg).find((q) => q.id === id)?.questions;
  const outcome = await waitForOperatorReply({
    cfg, topic: broadcastTopic(cfg.project), id, deadline: Date.now() + seconds * 1000, signal, mode: "poll",
    questions, intervalMs, read: (reply) => reply,
  });
  if (outcome.status === "skipped") {
    await closeQuestion(cfg, id).catch(() => {});
    return { id, status: "skipped" };
  }
  if (outcome.status !== "reply") return { id, status: "pending" };
  const reply = outcome.value;
  await closeQuestion(cfg, id).catch(() => {});
  sendReceipts(cfg, [outcome.messageId]);
  if (questions) {
    const selected = Object.values(reply.labels as Record<string, string[]>)[0];
    return { id, status: "answered", answer: selected.join(", "), selected, source: "unverified channel broadcast" };
  }
  return { id, answer: reply.answer, status: "answered", source: "unverified channel broadcast" };
}
