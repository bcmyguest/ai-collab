// Pure grouping of a session's activity rows into chat turns: a finished turn folds into one row plus its final message.
import { interleave, readableText, summarize } from "./activity-rows.js";

const SUMMARY_CHARS = 60;
// Seconds around a turn in which a chat message from the agent counts as the same text as its final row.
export const SLACK_S = 30;

const isStep = row => row.type === "tool_call" || row.type === "subagent" || ((row.type === "tool_result" || row.type === "error") && Boolean(row.tool));
const oneLine = text => text.replace(/\s+/g, " ").trim();
const clip = text => text.length > SUMMARY_CHARS ? text.slice(0, SUMMARY_CHARS - 1).trimEnd() + "…" : text;

/** Short subject of a turn: its prompt's first line, else its first tool's summary, else "the task". */
export function turnSummary(prompt, body) {
  const asked = prompt ? oneLine(readableText(prompt.input).text) : "";
  if (asked) return clip(asked);
  const first = body.find(row => row.type === "tool_call");
  return clip(oneLine(first ? summarize(first.input) : "")) || "the task";
}

/** Splits grouped rows into turns: rows from a prompt (or the start) to the next stop; a turn ended by a stop or a later prompt is done. */
export function splitTurns(rows) {
  const turns = [];
  let turn = null;
  for (const row of rows) {
    if (row.type === "prompt") { turn = { prompt: row, rows: [], stop: null }; turns.push(turn); continue; }
    if (!turn) { turn = { prompt: null, rows: [], stop: null }; turns.push(turn); }
    if (row.type === "stop") { turn.stop = row; turn = null; continue; }
    turn.rows.push(row);
  }
  turns.forEach((item, i) => { item.done = Boolean(item.stop) || i < turns.length - 1; });
  return turns;
}

/** Rows for the session thread plus the final messages to merge into chat; a done turn becomes a "turn" row and its final text a message, a running turn stays flat. */
export function chatTurns(rows, messages = [], session = "") {
  const own = messages.filter(item => item.from === session);
  const out = [];
  const finals = [];
  for (const turn of splitTurns(rows)) {
    if (!turn.done) { out.push(...turn.rows); continue; }
    const body = [...turn.rows];
    const at = body.findLastIndex(row => row.type === "text");
    const final = at >= 0 ? body[at] : null;
    if (final) {
      body.splice(at, 1);
      const start = (turn.prompt?.time ?? turn.rows[0].time ?? final.time) - SLACK_S;
      const end = Math.max(turn.stop?.time || 0, final.time || 0) + SLACK_S;
      const text = String(final.output || "").trim();
      const same = own.some(item => item.time >= start && item.time <= end && String(item.body).trim() === text);
      if (!same && text) finals.push({ id: "final:" + final.id, time: final.time, kind: "Message", sender: final.agent, from: final.agent, body: final.output });
    }
    if (!body.length) continue;
    const steps = body.filter(isStep).length;
    out.push({ id: "turn:" + body[0].id, type: "turn", agent: body[0].agent, time: body[0].time, summary: turnSummary(turn.prompt, body), steps, rows: body, done: true });
  }
  return { rows: out, messages: finals };
}

/** The session thread: chat messages and the agent's turns interleaved by time. */
export function chatThread(messages, rows, session) {
  const turns = chatTurns(rows, messages, session);
  const merged = [...messages, ...turns.messages].sort((a, b) => (a.time || 0) - (b.time || 0));
  return interleave(merged, turns.rows);
}

/** "Working on <summary> · 3 steps" for a turn row. */
export function turnLabel(row) {
  return "Working on " + row.summary + (row.steps ? " · " + row.steps + (row.steps === 1 ? " step" : " steps") : "");
}
