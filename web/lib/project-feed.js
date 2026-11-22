// Project chat feed: a completion row per finished session turn and one live row per busy session, from grouped activity rows.
import { interleave, runningSubagents, working } from "./activity-rows.js";
import { splitTurns, turnSummary } from "./chat-turns.js";

const firstLine = text => String(text || "").trim().split("\n")[0].trim();

/** Finished turns as "completion" rows: the session, its turn's stop time and the first line of its final message. */
export function completionRows(rows) {
  const sessions = new Map();
  for (const row of rows) sessions.set(row.agent, [...(sessions.get(row.agent) || []), row]);
  const out = [];
  for (const own of sessions.values()) {
    for (const turn of splitTurns(own)) {
      if (!turn.done || !turn.stop) continue;
      const final = turn.rows.findLast(row => row.type === "text" && String(row.output || "").trim());
      out.push({ id: "done:" + turn.stop.id, type: "completion", agent: turn.stop.agent, time: turn.stop.time || final?.time || 0, text: firstLine(final?.output) });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Chat messages with the completion rows, in time order. */
export function projectThread(messages, rows) {
  return interleave(messages, completionRows(rows));
}

/** One live row per session with an open tool call or a running subagent, named by its current turn's summary. */
export function liveRows(rows, now) {
  const busy = new Set([...working(rows, now), ...runningSubagents(rows, now).keys()]);
  return [...busy].sort().map(agent => {
    const turns = splitTurns(rows.filter(row => row.agent === agent));
    const current = turns.at(-1);
    return { id: "live:" + agent, type: "live", agent, summary: current ? turnSummary(current.prompt, current.rows) : "the task" };
  });
}
