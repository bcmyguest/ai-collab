// Pure grouping of a session's activity rows: the session timeline's flow of texts and tool groups, and the turns the project feed reads.
import { interleave, readableText, summarize } from "./activity-rows.js";
import { foldCompactionRestarts, pairCompactions } from "./compaction-view.js";
import { operatorPrompt } from "../../lib/machine-prompt.ts";

const SUMMARY_CHARS = 60;
// Seconds around a turn in which a chat message from the agent counts as the same text as its final row.
export const SLACK_S = 30;
// The browser has no environment; the wake flag is a server-side concern.
const NO_ENV = {};

const isStep = row => row.type === "tool_call" || row.type === "subagent" || ((row.type === "tool_result" || row.type === "error") && Boolean(row.tool));
const oneLine = text => text.replace(/\s+/g, " ").trim();
const clip = text => text.length > SUMMARY_CHARS ? text.slice(0, SUMMARY_CHARS - 1).trimEnd() + "…" : text;

/** One line of text, clipped to the summary width. */
export function clipSummary(text) {
  return clip(oneLine(String(text || "")));
}

/** Short subject of a turn: the operator's typed prompt's first line, else its first tool's summary, else "the task". */
export function turnSummary(prompt, body) {
  const asked = prompt && operatorPrompt(prompt.input, NO_ENV) ? oneLine(readableText(prompt.input).text) : "";
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

/** Removes a finished turn's last text from body; returns it as a chat message unless the session already posted it. */
function takeFinal(turn, body, own) {
  const at = body.findLastIndex(row => row.type === "text");
  if (at < 0) return null;
  const [final] = body.splice(at, 1);
  const start = (turn.prompt?.time ?? turn.rows[0].time ?? final.time) - SLACK_S;
  const end = Math.max(turn.stop?.time || 0, final.time || 0) + SLACK_S;
  const text = String(final.output || "").trim();
  const same = own.some(item => item.time >= start && item.time <= end && String(item.body).trim() === text);
  return !same && text ? { id: "final:" + final.id, time: final.time, kind: "Message", sender: final.agent, from: final.agent, body: final.output } : null;
}

/** Rows for the session thread plus the final messages to merge into chat; a done turn becomes a "turn" row and its final text a message, a running turn stays flat. */
export function chatTurns(rows, messages = [], session = "") {
  const own = messages.filter(item => item.from === session);
  const out = [];
  const finals = [];
  for (const turn of splitTurns(rows)) {
    if (!turn.done) { out.push(...turn.rows); continue; }
    const body = [...turn.rows];
    const final = takeFinal(turn, body, own);
    if (final) finals.push(final);
    if (!body.length) continue;
    const steps = body.filter(isStep).length;
    out.push({ id: "turn:" + body[0].id, type: "turn", agent: body[0].agent, time: body[0].time, summary: turnSummary(turn.prompt, body), steps, rows: body, done: true });
  }
  return { rows: out, messages: finals };
}

const isToolUse = row => row.type === "tool_call" || ((row.type === "tool_result" || row.type === "error") && Boolean(row.tool));

/** A run of consecutive tool uses between two assistant messages, one row; live while its turn runs. */
function toolGroup(rows) {
  return { id: "group:" + rows[0].id, type: "group", agent: rows[0].agent, time: rows[0].time, rows, steps: rows.length, tools: [...new Set(rows.map(row => row.tool || "tool"))], live: false };
}

/** A turn's rows in order: text stays a row, tool uses group between texts, subagent and other rows stand alone; a running turn's newest group is live until a text follows. */
function flowRows(body, done) {
  const out = [];
  let run = null;
  for (const row of body) {
    if (isToolUse(row)) { run ||= []; run.push(row); continue; }
    if (row.type === "text" && !String(row.output || "").trim()) continue;
    if (run) { out.push(toolGroup(run)); run = null; }
    out.push(row);
  }
  if (run) out.push(toolGroup(run));
  if (!done) {
    const at = out.findLastIndex(row => row.type === "group");
    if (at >= 0 && !out.slice(at + 1).some(row => row.type === "text")) out[at] = { ...out[at], live: true };
  }
  return out;
}

/** Session timeline rows (texts, tool groups, subagent and other rows) plus the final messages to merge into chat. */
export function chatFlow(rows, messages = [], session = "") {
  const own = messages.filter(item => item.from === session);
  const out = [];
  const finals = [];
  for (const turn of splitTurns(foldCompactionRestarts(pairCompactions(rows)))) {
    const body = [...turn.rows];
    if (turn.done) {
      const final = takeFinal(turn, body, own);
      if (final) finals.push(final);
    }
    out.push(...flowRows(body, turn.done));
  }
  return { rows: out, messages: finals };
}

/** Cuts each tool group at the chat messages that arrived during it, so its later tool uses sort after them; only the last piece of a live group stays live. */
function splitAtMessages(rows, times) {
  return rows.flatMap(row => {
    if (row.type !== "group") return [row];
    const span = row.rows.map(item => item.time || 0);
    const inside = times.filter(time => time >= Math.min(...span) && time < Math.max(...span));
    if (!inside.length) return [row];
    const pieces = [[]];
    for (const item of row.rows) {
      const piece = pieces.at(-1);
      const last = piece.at(-1);
      if (last && inside.some(time => time >= (last.time || 0) && time < (item.time || 0))) pieces.push([item]);
      else piece.push(item);
    }
    if (pieces.length === 1) return [row];
    return pieces.map((piece, i) => ({ ...toolGroup(piece), live: row.live && i === pieces.length - 1 }));
  });
}

/** The session thread: chat messages, assistant texts and tool groups interleaved by time. */
export function chatThread(messages, rows, session) {
  const flow = chatFlow(rows, messages, session);
  const merged = [...messages, ...flow.messages].sort((a, b) => (a.time || 0) - (b.time || 0));
  return interleave(merged, splitAtMessages(flow.rows, merged.map(item => item.time || 0)));
}

/** "Ran Bash · npm test" for one tool use, "Ran 2 tools · Bash, Read" for several. */
export function groupLabel(group) {
  if (group.steps !== 1) return "Ran " + group.steps + " tools · " + group.tools.join(", ");
  const summary = clipSummary(summarize(group.rows[0].input));
  return "Ran " + group.tools[0] + (summary ? " · " + summary : "");
}

/** "Working on <summary> · 3 steps" for a turn row. */
export function turnLabel(row) {
  return "Working on " + row.summary + (row.steps ? " · " + row.steps + (row.steps === 1 ? " step" : " steps") : "");
}
