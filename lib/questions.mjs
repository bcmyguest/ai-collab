import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { NTFY_MESSAGE_MAX_BYTES, broadcastTopic } from "./config.mjs";
import { pollCached, publish } from "./ntfy.mjs";
import { sendReceipts } from "./receipts.mjs";
import { statePath, withLock, writeState } from "./state.mjs";

const QUESTION_ID = /^[a-f0-9]{12}$/;
const MAX_QUESTION_BYTES = 2000;
const MAX_ANSWER_CHARS = 2000;
const REPLY = /^reply ([a-f0-9]{12}) ([\s\S]+)$/;
const OPEN_MAX = 20;
const CHOICE_MIN = 2;
const CHOICE_MAX = 6;
const CHOICE_QUESTION_MAX = 500;
const LABEL_MAX = 100;
const DESCRIPTION_MAX = 300;

const QUESTION_TEXT = /^Question from ([^\n]+)\n\n[\s\S]+\n\nReply in this topic: reply ([a-f0-9]{12}) YOUR ANSWER$/;

/** An agent's ask_question post as {sender, id}, or null. */
export function parseQuestionText(text) {
  const match = QUESTION_TEXT.exec(text);
  return match ? { sender: match[1], id: match[2] } : null;
}

export function parsePhoneReply(text) {
  const match = REPLY.exec(text);
  if (!match || !match[2].trim()) return null;
  return { id: match[1], answer: match[2].trim().slice(0, MAX_ANSWER_CHARS) };
}

// One option label matched case-insensitively, else the text itself (the "Other" answer).
function matchLabel(question, value) {
  const found = question.options.find((o) => o.label.toLowerCase() === value.trim().toLowerCase());
  return found ? found.label : value.trim();
}

/** Chosen labels per question from a reply: JSON {question: answer}, or plain text for a single question; null when incomplete. */
export function choiceLabels(questions, answer) {
  let map = null;
  try {
    const value = JSON.parse(answer);
    if (value && typeof value === "object" && !Array.isArray(value)) map = value;
  } catch { /* plain text */ }
  if (!map) {
    if (questions.length !== 1) return null;
    map = { [questions[0].question]: answer };
  }
  const labels = {};
  for (const q of questions) {
    const value = map[q.question];
    if (typeof value !== "string" || !value.trim()) return null;
    const parts = q.multiSelect ? value.split(",").filter((part) => part.trim()) : [value];
    labels[q.question] = parts.map((part) => matchLabel(q, part));
  }
  return labels;
}

/** Answers for a choice from a reply: {question: "label, label"}, or null when incomplete. */
export function parseChoice(questions, answer) {
  const labels = choiceLabels(questions, answer);
  return labels && Object.fromEntries(Object.entries(labels).map(([question, parts]) => [question, parts.join(", ")]));
}

// A choice answer as the text the agent reads; a plain answer passes through.
function answerText(questions, answer) {
  if (!questions) return answer;
  const labels = choiceLabels(questions, answer);
  return labels && Object.values(labels).map((parts) => parts.join(", ")).join("; ");
}

// The ask_question options as choices, or null without options; throws on a shape the phone cannot show.
function validateChoices(question, options, multiSelect) {
  if (options === undefined) {
    if (multiSelect) throw new Error("multi_select needs options");
    return null;
  }
  if (!Array.isArray(options) || options.length < CHOICE_MIN || options.length > CHOICE_MAX) {
    throw new Error(`Options must be an array of ${CHOICE_MIN} to ${CHOICE_MAX} choices`);
  }
  if (Array.from(question.trim()).length > CHOICE_QUESTION_MAX) throw new Error(`A question with options takes ${CHOICE_QUESTION_MAX} characters at most`);
  const seen = new Set();
  return options.map((o) => {
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

function questionsFile(cfg) {
  return statePath(cfg).replace(/\.json$/, ".questions.json");
}

/** Open questions this session asked: [{id, important, askedAt, questions?}], oldest first; questions are set for choice cards. */
export function openQuestions(cfg) {
  if (!cfg.session) return [];
  try {
    const list = JSON.parse(readFileSync(questionsFile(cfg), "utf8")).open;
    return Array.isArray(list)
      ? list.filter((q) => QUESTION_ID.test(q?.id) && Number.isFinite(q.askedAt))
        .map(({ id, important, askedAt, questions }) => ({ id, important: important === true, askedAt, ...(Array.isArray(questions) ? { questions } : {}) }))
      : [];
  } catch {
    return [];
  }
}

async function updateQuestions(cfg, change) {
  if (!cfg.session) return;
  const file = questionsFile(cfg);
  await withLock(file, () => writeState(file, { open: change(openQuestions(cfg)).slice(-OPEN_MAX) }));
}

function waitFile(cfg) {
  return statePath(cfg).replace(/\.json$/, ".wait.json");
}

/** Ask the next Stop hook to wait for the operator (AFK mode ON); the Stop clears it when it ends or delivers. */
export async function requestWait(cfg, now = Date.now()) {
  if (!cfg.session) return;
  const file = waitFile(cfg);
  await withLock(file, () => writeState(file, { requestedAt: now }));
}

/** Time of this session's pending wait request, or 0. */
export function waitRequestedAt(cfg) {
  try { return Number(JSON.parse(readFileSync(waitFile(cfg), "utf8")).requestedAt) || 0; } catch { return 0; }
}

export async function clearWait(cfg) {
  if (!cfg.session || !waitRequestedAt(cfg)) return;
  const file = waitFile(cfg);
  await withLock(file, () => rmSync(file, { force: true })).catch(() => {});
}

export const closeQuestion = (cfg, id) => updateQuestions(cfg, (open) => open.filter((q) => q.id !== id));

/** Answers on the broadcast topic for the given question IDs, since the oldest one was asked. */
export async function findAnswers(cfg, questions, { poll = pollCached } = {}) {
  if (!questions.length) return [];
  const since = String(Math.floor(Math.min(...questions.map((q) => q.askedAt)) / 1000) - 60);
  const asked = new Map(questions.map((q) => [q.id, q]));
  const found = new Map();
  for (const ev of await poll(cfg, broadcastTopic(cfg.project), since)) {
    const reply = parsePhoneReply(ev.message);
    const question = reply && asked.get(reply.id);
    if (!question || found.has(reply.id)) continue;
    const answer = answerText(question.questions, reply.answer);
    if (answer) found.set(reply.id, { id: reply.id, answer, messageId: ev.id });
  }
  return [...found.values()];
}

function validateWait(seconds) {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 45) {
    throw new Error("Wait must be an integer from 0 to 45 seconds");
  }
}

/**
 * Asks the operator's phone. Options make a choice card (the approval envelope of lib/approvals.mjs); the answer is the chosen labels.
 * Without options the phone gets a text question with a reply field.
 */
export async function askQuestion(cfg, question, options = {}) {
  validateWait(options.seconds ?? 25);
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
  let questions;
  if (choices) {
    // Same envelope as a permission choice, so the UI renders the same card; expiresAt 0 keeps it open until answered.
    questions = [{ question: question.trim(), header: "", multiSelect, options: choices }];
    const card = {
      v: 1, kind: "approval", from: cfg.peer, ...(cfg.session ? { session: cfg.session } : {}), harness: options.harness || "other",
      id, tool: "ask_question", summary: question.trim(), expiresAt: 0, questions, ts: new Date().toISOString(),
    };
    const message = JSON.stringify(card);
    if (Buffer.byteLength(message) > NTFY_MESSAGE_MAX_BYTES) throw new Error(`The question and its options exceed ${NTFY_MESSAGE_MAX_BYTES} bytes`);
    await publish(cfg, topic, message, { title });
  } else {
    // The first line stays "Question from <sender>": the operator UI parses it.
    const text = `Question from ${sender}\n\n${important ? "IMPORTANT, the agent waits for this answer: " : ""}${question.trim()}\n\nReply in this topic: reply ${id} YOUR ANSWER`;
    await publish(cfg, topic, text, { title });
  }
  await updateQuestions(cfg, (open) => [...open, { id, important, askedAt: options.now ?? Date.now(), ...(questions ? { questions } : {}) }]).catch(() => {});
  await requestWait(cfg, options.now ?? Date.now()).catch(() => {});
  try {
    return await waitForAnswer(cfg, id, { ...options, questions });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return { id, status: "pending", note: "The question was published, but reading answers failed. Call wait_for_answer to retry." };
  }
}

export async function waitForAnswer(cfg, id, { seconds = 25, signal, intervalMs = 4000, questions: known } = {}) {
  if (typeof id !== "string" || !QUESTION_ID.test(id)) throw new Error("Invalid question ID");
  validateWait(seconds);
  const deadline = Date.now() + seconds * 1000;
  const topic = broadcastTopic(cfg.project);
  const questions = known ?? openQuestions(cfg).find((q) => q.id === id)?.questions;
  let since = "12h";
  while (true) {
    signal?.throwIfAborted();
    const events = await pollCached(cfg, topic, since, signal);
    since = events.at(-1)?.id ?? since;
    const event = events.find((ev) => {
      const reply = parsePhoneReply(ev.message);
      return reply?.id === id && (!questions || choiceLabels(questions, reply.answer));
    });
    const reply = event && parsePhoneReply(event.message);
    if (reply) {
      await closeQuestion(cfg, id).catch(() => {});
      sendReceipts(cfg, [event.id]);
      if (questions) {
        const selected = Object.values(choiceLabels(questions, reply.answer))[0];
        return { id, status: "answered", answer: selected.join(", "), selected, source: "unverified ntfy broadcast" };
      }
      return { ...reply, status: "answered", source: "unverified ntfy broadcast" };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { id, status: "pending" };
    await delay(Math.min(intervalMs, remaining), undefined, { signal });
  }
}
