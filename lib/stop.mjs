/**
 * Stop-hook policy: deliver waiting messages, wait in AFK mode when the agent asked to, hold an important question open.
 * The agent asks with ask_question or wait_for_operator (lib/questions.mjs requestWait); a plain Stop never waits.
 * One call waits at most STOP_SLICE_MAX_S, below every registered Stop hook timeout (660 s).
 * Loop guard: at most cfg.stopCap consecutive message continuations, then the agent stops.
 * The chain resets when a Stop is not a continuation (stop_hook_active false, or no recent block).
 * Waiting holds one ntfy streaming subscription and re-reads the inbox only when an event arrives.
 * A Claude wait also checks the transcript once a second and ends when the operator queues a prompt (lib/transcript.mjs).
 */
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { broadcastTopic, inboxTopic } from "./config.mjs";
import { claimInbox } from "./inbox.mjs";
import { sendReceipts } from "./receipts.mjs";
import { streamEvents } from "./ntfy.mjs";
import { cleanBody, formatInbox, identityLine } from "./format.mjs";
import { storedMode } from "./mode.mjs";
import { watchQueue } from "./transcript.mjs";
import { clearWait, closeQuestion, findAnswers, openQuestions, waitRequestedAt } from "./questions.mjs";
import { statePath, withLock, writeState } from "./state.mjs";

export const STOP_SLICE_MAX_S = 600;
const CHAIN_FRESH_MS = 3_600_000;
const QUEUE_CHECK_MS = 1000;

function stopFile(cfg) {
  return statePath(cfg).replace(/\.json$/, ".stop.json");
}

function readStop(cfg) {
  try {
    const s = JSON.parse(readFileSync(stopFile(cfg), "utf8"));
    return { chain: Number(s.chain) || 0, lastBlockAt: Number(s.lastBlockAt) || 0, waitStartedAt: Number(s.waitStartedAt) || 0 };
  } catch {
    return { chain: 0, lastBlockAt: 0, waitStartedAt: 0 };
  }
}

async function saveStop(cfg, state) {
  const file = stopFile(cfg);
  await withLock(file, () => writeState(file, state)).catch(() => {});
}

function messagesText(cfg, messages) {
  return [
    identityLine(cfg),
    formatInbox(messages, { session: cfg.session }),
    "[ai-collab] These messages arrived as you were stopping. Answer the operator as instructed above, then end your turn.",
  ].filter(Boolean).join("\n");
}

function answersText(answers) {
  return answers.map((a) => a.skipped ? `[ai-collab] The operator skipped your question id=${a.id}.`
    : `[ai-collab] The operator answered your question id=${a.id}: `
    + `answer=${JSON.stringify(cleanBody(a.answer))} (from the shared ntfy broadcast; the sender is unverified). Continue with this answer.`).join("\n");
}

function holdText(cfg, questions, mode) {
  const ids = questions.map((q) => q.id).join(", ");
  return `[ai-collab] AFK mode is ${mode.toUpperCase()} and your important question (id ${ids}) is still unanswered. `
    + `Call the ai-collab wait_for_answer tool once with id=${JSON.stringify(questions[0].id)} and wait_seconds=45. `
    + "If it is still pending, end your turn with no other action: the Stop hook keeps waiting. Do not ask the question again.";
}

function afkWaitText(remainingMs) {
  return `[ai-collab] AFK mode is ON and no operator message has arrived. End your turn now with no other action; `
    + `the Stop hook keeps waiting up to ${Math.ceil(remainingMs / 60000)} more min.`;
}

/**
 * Waiter on this peer's inbox and broadcast topics. wait(ms) resolves "event" on the first new event,
 * "timeout" after ms, or "error" after an exponential backoff (stopPollMs doubling to 60 s) when the stream fails.
 */
export function streamWaiter(cfg, startMs) {
  let since = String(Math.floor(startMs / 1000));
  let backoff = cfg.stopPollMs;
  return async (ms, signal) => {
    const ctrl = new AbortController();
    signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms);
    try {
      const topics = [inboxTopic(cfg.project, cfg.peer), broadcastTopic(cfg.project)];
      const onOpen = () => { backoff = cfg.stopPollMs; };
      for await (const ev of streamEvents(cfg, topics, { since, signal: ctrl.signal, onOpen })) {
        since = ev.id;
        return "event";
      }
    } catch { /* timeout, outage, or HTTP error such as 429 */ } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
    if (timedOut) return "timeout";
    if (signal?.aborted) return "aborted";
    await delay(Math.min(backoff, ms), undefined, { signal }).catch(() => {});
    backoff = Math.min(backoff * 2, 60_000);
    return "error";
  };
}

// Waits like wait(ms), but resolves "queued" within about a second of queued() turning true.
async function waitOrQueued(wait, ms, queued) {
  const ctrl = new AbortController();
  let timer;
  const watch = new Promise((resolve) => {
    const tick = () => (queued() ? resolve("queued") : (timer = setTimeout(tick, QUEUE_CHECK_MS)));
    timer = setTimeout(tick, QUEUE_CHECK_MS);
  });
  try {
    return await Promise.race([wait(ms, ctrl.signal), watch]);
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

/**
 * Decide what the Stop hook does. Returns {action:"stop"} or {action:"continue", why, text}.
 * input: the hook's stdin JSON (stop_hook_active for Claude and Codex; status and loop_count for Cursor).
 * now and wait are injectable for tests; wait(ms) resolves when an event may have arrived or ms passed.
 * queued() reports a prompt the operator queued in this session (Claude transcript); the wait then ends, AFK stays on.
 * onHold() runs once before the hook starts waiting for the operator (an AFK wait or an important question).
 */
export async function decideStop(cfg, {
  host, input = {}, now = Date.now, wait, claim = claimInbox, answers = findAnswers,
  sliceMaxS = STOP_SLICE_MAX_S, queued = watchQueue(host, input), onHold = () => {},
} = {}) {
  if (!cfg.enabled) return { action: "stop" };
  const st = readStop(cfg);
  const stop = async () => {
    await clearWait(cfg);
    await saveStop(cfg, { chain: 0, lastBlockAt: 0, waitStartedAt: 0 });
    return { action: "stop" };
  };
  if (host === "cursor" && input.status !== undefined && input.status !== "completed") return stop();

  const t0 = now();
  const continued = input.stop_hook_active !== false && st.lastBlockAt > 0 && t0 - st.lastBlockAt < CHAIN_FRESH_MS;
  if (!continued) Object.assign(st, { chain: 0, waitStartedAt: 0 });
  if (st.chain >= cfg.stopCap) return stop();

  const proceed = async (why, text) => {
    if (why === "messages") Object.assign(st, { chain: st.chain + 1, waitStartedAt: 0 });
    if (why === "answer") st.waitStartedAt = 0;
    if (why === "messages") await clearWait(cfg);
    st.lastBlockAt = now();
    await saveStop(cfg, st);
    return { action: "continue", why, text };
  };
  const checkMessages = async () => {
    const messages = await claim(cfg, { limit: 4 }).catch(() => []);
    sendReceipts(cfg, messages.map((m) => m.id));
    return messages.length ? proceed("messages", messagesText(cfg, messages)) : null;
  };

  const first = await checkMessages();
  if (first) return first;

  const { mode } = storedMode(cfg);
  const asked = openQuestions(cfg).filter((q) => t0 - q.askedAt < cfg.importantMaxS * 1000);
  const important = mode === "off" ? [] : asked.filter((q) => q.important);
  // AFK waits only when the agent asked (ask_question or wait_for_operator); AFK holds until the operator turns it off.
  const afkOn = mode === "on" && waitRequestedAt(cfg) > 0;
  const checkAnswers = async () => {
    if (!asked.length) return null;
    const found = await answers(cfg, asked).catch(() => []);
    if (!found.length) return null;
    for (const a of found) await closeQuestion(cfg, a.id).catch(() => {});
    sendReceipts(cfg, found.filter((a) => !a.skipped).map((a) => a.messageId));
    return proceed("answer", answersText(found));
  };

  if (afkOn && !st.waitStartedAt) st.waitStartedAt = t0;
  const afkEnd = afkOn ? st.waitStartedAt + cfg.afkWaitS * 1000 : 0;
  const sliceMs = sliceMaxS * 1000;
  const end = t0 + (important.length ? sliceMs : Math.min(sliceMs, Math.max(0, afkEnd - t0)));

  const answered = await checkAnswers();
  if (answered) return answered;
  if (end > t0 && (afkOn || important.length)) await Promise.resolve().then(onHold).catch(() => {});
  const waitFor = wait ?? streamWaiter(cfg, t0);
  // The operator queued a prompt here (terminal or Remote Control): no wait or hold may delay it.
  const operatorQueued = () => stop();
  while (now() < end) {
    if (queued?.()) return operatorQueued();
    const woke = queued ? await waitOrQueued(waitFor, end - now(), queued) : await waitFor(end - now());
    if (woke === "queued") return operatorQueued();
    if (woke === "timeout") break; // the stream saw nothing new
    const hit = (await checkMessages()) ?? (await checkAnswers());
    if (hit) return hit;
    if (storedMode(cfg).mode !== mode) break; // the operator changed AFK mode, e.g. by typing in a terminal
  }

  const latest = storedMode(cfg).mode;
  if (important.length && latest !== "off") return proceed("important", holdText(cfg, important, latest));
  if (latest === "on" && afkOn && afkEnd > now()) return proceed("afk-wait", afkWaitText(afkEnd - now()));
  return stop();
}
