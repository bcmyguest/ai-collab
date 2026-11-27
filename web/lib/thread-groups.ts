// The sidebar's thread groups, each row's harness marks, working time and short session names.
import { sessionState } from "./session-state.js";
import { threadStatus } from "./threads.js";

export type Agent = {
  id: string; peer?: string; name?: string; identityName?: string; generatedName?: boolean; gone?: boolean;
  openCallAt?: number; turnStartAt?: number; lastActivityAt?: number; lastMessageAt?: number; [key: string]: unknown;
};
export type ThreadPr = { id?: string; number?: number; url?: string; state?: string; head?: string; base?: string };
export type Thread = {
  id: string; title?: string; branch?: string; worktree?: string; baseRef?: string; status?: string; pinned?: boolean;
  leadSession?: string; sessions?: string[]; prs?: ThreadPr[]; createdAt?: number; updatedAt?: number;
};
export type ThreadRow = Thread & { shown: string; agents: Agent[]; harnesses: string[] };
export type GroupId = "pinned" | "waiting" | "working" | "active" | "settled" | "snoozed" | "archived";

// Open groups first, in the order the operator acts on them; snoozed and archived start collapsed.
export const GROUPS: [GroupId, string][] = [
  ["pinned", "Pinned"], ["waiting", "Waiting on you"], ["working", "Working"], ["active", "Active"],
  ["settled", "Settled"], ["snoozed", "Snoozed"], ["archived", "Archived"],
];
export const COLLAPSED: GroupId[] = ["snoozed", "archived"];
const NAME_WORDS = 5;
const NAME_CHARS = 40;

/** Each thread with its session cards, shown status and harnesses, placed in one group; archived stays archived even when pinned. */
export function threadGroups(threads: Thread[] = [], agents: Agent[] = [], now: number): Record<GroupId, ThreadRow[]> {
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  const groups = Object.fromEntries(GROUPS.map(([id]) => [id, [] as ThreadRow[]])) as Record<GroupId, ThreadRow[]>;
  for (const thread of threads) {
    const sessions = (thread.sessions || []).map(id => byId.get(id)).filter((agent): agent is Agent => Boolean(agent));
    const shown = threadStatus(thread.status, sessions, now) as string;
    const harnesses = [...new Set((thread.sessions || []).map(id => byId.get(id)?.peer || id.split("#")[0]).filter(Boolean))];
    const row = { ...thread, shown, agents: sessions, harnesses };
    const group: GroupId = shown === "archived" || shown === "snoozed" ? shown : thread.pinned ? "pinned"
      : (GROUPS.some(([id]) => id === shown) ? shown : "active") as GroupId;
    groups[group].push(row);
  }
  for (const rows of Object.values(groups)) rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return groups;
}

/** Live sessions no thread lists, so a store without threads still shows every session. */
export function unthreaded(agents: Agent[] = [], threads: Thread[] = []): Agent[] {
  const listed = new Set(threads.flatMap(thread => thread.sessions || []));
  return agents.filter(agent => !agent.gone && !listed.has(agent.id));
}

/** The session a thread opens: its lead when it still has a card, else its first listed session. */
export function threadSession(thread: Thread, agents: Agent[] = []): string {
  const known = new Set(agents.map(agent => agent.id));
  if (thread.leadSession && known.has(thread.leadSession)) return thread.leadSession;
  return (thread.sessions || []).find(id => known.has(id)) || thread.leadSession || thread.sessions?.[0] || "";
}

/** Compact elapsed time: 45s, 12m, 3h, 2d. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return seconds + "s";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h";
  return Math.floor(seconds / 86400) + "d";
}

/**
 * How long a working thread has worked: from its earliest turn start. A harness that reports no prompt has none, so its
 * oldest open tool call stands in, else its newest activity. Empty when no session works.
 */
export function workingTime(row: ThreadRow, now: number): string {
  const working = row.agents.filter(agent => sessionState(agent, now) === "working");
  if (!working.length) return "";
  const earliest = (key: "turnStartAt" | "openCallAt") => Math.min(...working.map(agent => Number(agent[key]) || Infinity));
  const turn = earliest("turnStartAt");
  const call = earliest("openCallAt");
  const from = turn < Infinity ? turn : call < Infinity ? call : Math.max(...working.map(agent => Number(agent.lastActivityAt) || 0));
  return from ? elapsed(now - from) : "";
}

/** A few words for a session: its set_identity name, else its harness title or first prompt, else the thread's title. */
export function shortName(agent: Agent | undefined, threadTitle = ""): string {
  const text = (agent?.identityName || agent?.name || threadTitle || "").trim();
  const words = text.split(/\s+/).filter(Boolean);
  const cut = words.slice(0, NAME_WORDS).join(" ");
  const name = cut.length > NAME_CHARS ? cut.slice(0, NAME_CHARS - 1).trimEnd() + "…" : cut;
  return words.length > NAME_WORDS && !name.endsWith("…") ? name + "…" : name;
}
