// Project chat feed: a completion row per finished session turn and one live row per busy session, from grouped activity rows.
import { clipSummary, SLACK_S, splitTurns } from "./chat-turns.js";
import { interleave, readableText, runningSubagents, summarize } from "./activity-rows.js";
import { WORKING_MS } from "./session-state.js";
import { machinePrompt, operatorPrompt } from "../../lib/machine-prompt.mjs";

// A turn counts as finished only when its stop row says the turn ended; "session ended" and subagent stops do not.
const TURN_ENDED = /^turn ended/;
// The activity feed's tool label for harness and agent messages arriving as prompts; they are not the agent's reply.
const AGENT_MESSAGE = "Agent message";
// The browser has no environment; the wake flag is a server-side concern.
const NO_ENV = {};

const firstLine = text => String(text || "").trim().split("\n")[0].trim();
// Seconds of a turn's newest row, its prompt included.
const newestOf = turn => Math.max(turn.prompt?.time || 0, ...turn.rows.map(row => row.lastTime ?? row.time ?? 0));

/** Items grouped by key in one pass, each group in arrival order. */
function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item); else groups.set(key, [item]);
  }
  return groups;
}

/** The operator's typed prompt that opened a turn, or null for a machine or wake prompt. */
function typedPrompt(turn) {
  return turn.prompt && operatorPrompt(turn.prompt.input, NO_ENV) ? turn.prompt : null;
}

/** The turn's final reply: its last text the agent wrote, not a harness or agent message; null when none. */
function finalReply(turn) {
  return turn.rows.findLast(row => row.type === "text" && row.tool !== AGENT_MESSAGE && String(row.output || "").trim() && !machinePrompt(row.output)) || null;
}

/** Each session's turns (splitTurns) from grouped rows: session → turns. */
export function sessionTurns(rows) {
  return new Map([...groupBy(rows, row => row.agent)].map(([agent, own]) => [agent, splitTurns(own)]));
}

/** Operator answers whose question or approval card is in the list; the card shows the answer, so its bubble goes. */
export function withoutAnswered(messages) {
  const asks = new Set();
  for (const message of messages) {
    if (message.kind === "Question" && message.question) asks.add(message.question);
    if (message.kind === "Approval" && message.approval?.id) asks.add(message.approval.id);
  }
  return messages.filter(message => !(message.replyTo && asks.has(message.replyTo)));
}

/** Consecutive completion rows of one session become one row: its turn count and the last text it had. */
function collapse(rows) {
  const out = [];
  for (const row of rows) {
    const last = out.at(-1);
    if (last && last.agent === row.agent) out[out.length - 1] = { ...last, turns: last.turns + 1, time: row.time, text: row.text || last.text };
    else out.push(row);
  }
  return out;
}

/**
 * Finished turns as "completion" rows. A turn counts when it ends with a reply or the operator typed its prompt;
 * its text is the final reply's first line, unless the session already posted that text nearby.
 */
export function completionRows(turnsByAgent, messages = []) {
  const said = groupBy(messages, message => message.from);
  const out = [];
  for (const [agent, turns] of turnsByAgent) {
    for (const turn of turns) {
      if (!turn.stop || !TURN_ENDED.test(turn.stop.input || "") || !turn.rows.length) continue;
      const reply = finalReply(turn);
      if (!reply && !typedPrompt(turn)) continue;
      const time = turn.stop.time || reply?.time || 0;
      const repeated = Boolean(reply) && (said.get(agent) || []).some(message => Math.abs((message.time || 0) - time) <= SLACK_S && String(message.body).trim() === String(reply.output).trim());
      out.push({ id: "done:" + turn.stop.id, type: "completion", agent, time, text: reply && !repeated ? firstLine(reply.output) : "", turns: 1 });
    }
  }
  return collapse(out.sort((a, b) => a.time - b.time));
}

/** Chat messages with the completion rows, in time order. */
export function projectThread(messages, turnsByAgent) {
  return interleave(messages, completionRows(turnsByAgent, messages));
}

/** The typed prompt's first line, else the latest tool call's summary; "" when the turn has neither. */
function liveSummary(turn) {
  if (!turn) return "";
  const asked = typedPrompt(turn);
  if (asked) return clipSummary(readableText(asked.input).text);
  const latest = turn.rows.findLast(row => row.type === "tool_call");
  return latest ? clipSummary(summarize(latest.input)) : "";
}

/** One live row per busy session: its last turn has no stop and a row within WORKING_MS, or it has a running subagent. */
export function liveRows(turnsByAgent, rows, now) {
  const busy = new Set(runningSubagents(rows, now).keys());
  for (const [agent, turns] of turnsByAgent) {
    const current = turns.at(-1);
    if (current && !current.stop && now - newestOf(current) * 1000 < WORKING_MS) busy.add(agent);
  }
  return [...busy].sort().map(agent => ({ id: "live:" + agent, type: "live", agent, summary: liveSummary(turnsByAgent.get(agent)?.at(-1)) }));
}
