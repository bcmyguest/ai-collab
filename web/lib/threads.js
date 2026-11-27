// Thread helpers shared by the sidebar and its tests: the shown status and the session rows a thread nests.
import { sessionState } from "./session-state.js";

export const THREAD_STATUS_LABELS = {
  waiting: "Waiting on you", working: "Working", active: "Active", snoozed: "Snoozed", settled: "Settled", archived: "Archived",
};

/** The shown status: waiting when a session waits on the operator, working when one works, else the stored status. */
export function threadStatus(stored, sessions, now) {
  const states = sessions.map(session => sessionState(session, now));
  if (states.some(state => state === "waiting" || state === "afk")) return "waiting";
  if (states.includes("working")) return "working";
  return stored || "active";
}

/** Each listed thread with its session cards and shown status; archived threads stay out unless one of them waits. */
export function threadRows(threads, agents, now) {
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  return (threads || []).flatMap(thread => {
    const sessions = (thread.sessions || []).map(id => byId.get(id)).filter(Boolean);
    const status = threadStatus(thread.status, sessions, now);
    return status === "archived" ? [] : [{ ...thread, status, stored: thread.status, agents: sessions }];
  });
}
