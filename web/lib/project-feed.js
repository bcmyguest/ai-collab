// Project chat feed: a completion row per finished session turn and one live row per busy session, from grouped activity rows.
import { interleave, runningSubagents } from "./activity-rows.js";
import { SLACK_S, splitTurns, turnSummary } from "./chat-turns.js";
import { WORKING_MS } from "./session-state.js";

// A turn counts as finished only when its stop row says the turn ended; "session ended" and subagent stops do not.
const TURN_ENDED = /^turn ended/;

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

/** Finished turns as "completion" rows; the first line of the final message, unless the session already posted that text nearby. */
export function completionRows(turnsByAgent, messages = []) {
  const said = groupBy(messages, message => message.from);
  const out = [];
  for (const [agent, turns] of turnsByAgent) {
    for (const turn of turns) {
      if (!turn.stop || !TURN_ENDED.test(turn.stop.input || "") || !turn.rows.length) continue;
      const final = turn.rows.findLast(row => row.type === "text" && String(row.output || "").trim());
      const time = turn.stop.time || final?.time || 0;
      const repeated = Boolean(final) && (said.get(agent) || []).some(message => Math.abs((message.time || 0) - time) <= SLACK_S && String(message.body).trim() === String(final.output).trim());
      out.push({ id: "done:" + turn.stop.id, type: "completion", agent, time, text: repeated ? "" : firstLine(final?.output) });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Chat messages with the completion rows, in time order. */
export function projectThread(messages, turnsByAgent) {
  return interleave(messages, completionRows(turnsByAgent, messages));
}

/** One live row per busy session: its last turn has no stop and a row within WORKING_MS, or it has a running subagent. */
export function liveRows(turnsByAgent, rows, now) {
  const busy = new Set(runningSubagents(rows, now).keys());
  for (const [agent, turns] of turnsByAgent) {
    const current = turns.at(-1);
    if (current && !current.stop && now - newestOf(current) * 1000 < WORKING_MS) busy.add(agent);
  }
  return [...busy].sort().map(agent => {
    const current = turnsByAgent.get(agent)?.at(-1);
    return { id: "live:" + agent, type: "live", agent, summary: current ? turnSummary(current.prompt, current.rows) : "the task" };
  });
}
