import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { broadcastTopic } from "./config.mjs";
import { pollCached, publish } from "./ntfy.mjs";
import { sendReceipts } from "./receipts.mjs";
import { statePath, withLock, writeState } from "./state.mjs";

const QUESTION_ID = /^[a-f0-9]{12}$/;
const MAX_QUESTION_BYTES = 2000;
const MAX_ANSWER_CHARS = 2000;
const REPLY = /^reply ([a-f0-9]{12}) ([\s\S]+)$/;
const OPEN_MAX = 20;

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

function validateWait(seconds) {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 45) {
    throw new Error("Wait must be an integer from 0 to 45 seconds");
  }
}

function questionsFile(cfg) {
  return statePath(cfg).replace(/\.json$/, ".questions.json");
}

/** Open questions this session asked: [{id, important, askedAt}], oldest first. */
export function openQuestions(cfg) {
  if (!cfg.session) return [];
  try {
    const list = JSON.parse(readFileSync(questionsFile(cfg), "utf8")).open;
    return Array.isArray(list)
      ? list.filter((q) => QUESTION_ID.test(q?.id) && Number.isFinite(q.askedAt)).map(({ id, important, askedAt }) => ({ id, important: important === true, askedAt }))
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

export const closeQuestion = (cfg, id) => updateQuestions(cfg, (open) => open.filter((q) => q.id !== id));

/** Answers on the broadcast topic for the given question IDs, since the oldest one was asked. */
export async function findAnswers(cfg, questions, { poll = pollCached } = {}) {
  if (!questions.length) return [];
  const since = String(Math.floor(Math.min(...questions.map((q) => q.askedAt)) / 1000) - 60);
  const ids = new Set(questions.map((q) => q.id));
  const found = new Map();
  for (const ev of await poll(cfg, broadcastTopic(cfg.project), since)) {
    const reply = parsePhoneReply(ev.message);
    if (reply && ids.has(reply.id) && !found.has(reply.id)) found.set(reply.id, { ...reply, messageId: ev.id });
  }
  return [...found.values()];
}

export async function askQuestion(cfg, question, options = {}) {
  validateWait(options.seconds ?? 25);
  if (typeof question !== "string" || !question.trim() || Buffer.byteLength(question) > MAX_QUESTION_BYTES) {
    throw new Error("Question must contain 1–2000 UTF-8 bytes");
  }
  const id = randomBytes(6).toString("hex");
  const sender = cfg.session ? `${cfg.peer}#${cfg.session}` : cfg.peer;
  const topic = broadcastTopic(cfg.project);
  const important = options.important === true;
  // The first line stays "Question from <sender>": the operator UI parses it.
  const text = `Question from ${sender}\n\n${important ? "IMPORTANT, the agent waits for this answer: " : ""}${question.trim()}\n\nReply in this topic: reply ${id} YOUR ANSWER`;
  await publish(cfg, topic, text, { title: `${important ? "Important question" : "Question"} from ${sender}` });
  await updateQuestions(cfg, (open) => [...open, { id, important, askedAt: options.now ?? Date.now() }]).catch(() => {});
  try {
    return await waitForAnswer(cfg, id, options);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return { id, status: "pending", note: "The question was published, but reading answers failed. Call wait_for_answer to retry." };
  }
}

export async function waitForAnswer(cfg, id, { seconds = 25, signal, intervalMs = 4000 } = {}) {
  if (typeof id !== "string" || !QUESTION_ID.test(id)) throw new Error("Invalid question ID");
  validateWait(seconds);
  const deadline = Date.now() + seconds * 1000;
  const topic = broadcastTopic(cfg.project);
  let since = "12h";
  while (true) {
    signal?.throwIfAborted();
    const events = await pollCached(cfg, topic, since, signal);
    since = events.at(-1)?.id ?? since;
    const event = events.find((ev) => parsePhoneReply(ev.message)?.id === id);
    const reply = event && parsePhoneReply(event.message);
    if (reply) {
      await closeQuestion(cfg, id).catch(() => {});
      sendReceipts(cfg, [event.id]);
      return { ...reply, status: "answered", source: "unverified ntfy broadcast" };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { id, status: "pending" };
    await delay(Math.min(intervalMs, remaining), undefined, { signal });
  }
}
