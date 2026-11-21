// Pure session-state helpers shared by the UI server (ui.mjs), the Home and Sessions views, and their tests.
import { runState } from "./activity-rows.js";

export const RECENT_MS = 60_000;
export const WORKING_MS = 15 * 60_000;
export const STATES = ["waiting", "afk", "working", "idle", "offline"];
export const STATE_LABELS = { waiting: "Waiting on you", afk: "AFK hold", working: "Working", idle: "Idle", offline: "Offline" };
const FIRST_WORDS = 6;

/**
 * State of one session card from server facts:
 * waiting (an open approval, choice or important question), afk (its Stop hook holds the turn in AFK mode),
 * working (an open tool call under 15 min old, a running subagent, or activity in the last 60 s), idle (online), else offline.
 */
export function sessionState(s, now) {
  if (s.pending?.some(p => p.blocking && !(p.expiresAt && p.expiresAt < now))) return "waiting";
  if (s.online && s.afkHold) return "afk";
  if (s.openCallAt && now - s.openCallAt < WORKING_MS) return "working";
  if (s.lastActivityAt && now - s.lastActivityAt < RECENT_MS) return "working";
  if (s.subagents?.some(run => runState(run, now) === "running")) return "working";
  return s.online ? "idle" : "offline";
}

/** The wake to show for a session, or null once it reported after the wake began or the wake is no longer running. */
export function visibleWake(wake, agent) {
  if (!wake?.status) return null;
  const reported = Math.max(agent?.seenAt || 0, agent?.statusAt || 0);
  if (wake.at && reported > wake.at) return null;
  // A finished wake whose session is back online needs no banner; a failed one keeps its Retry.
  if (wake.status !== "waking" && wake.status !== "failed" && agent?.online) return null;
  return wake;
}

/** "<folder>: first words of the first prompt", the folder alone, or "". */
export function fallbackName(folder, prompt) {
  const words = typeof prompt === "string" ? prompt.replace(/\s+/g, " ").trim().split(" ").slice(0, FIRST_WORDS).join(" ") : "";
  return [folder, words].filter(Boolean).join(": ").slice(0, 80);
}

/** Cards ordered by state, then newest activity; children whose parent is listed nest under it and lift its group. */
export function sessionTree(sessions, now) {
  const byId = new Map(sessions.map(s => [s.id, { ...s, state: sessionState(s, now), children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    const parent = node.parent && node.parent !== node.id ? byId.get(node.parent) : null;
    if (parent && !isAncestor(byId, node.id, parent.id)) parent.children.push(node);
    else roots.push(node);
  }
  const rank = node => Math.min(STATES.indexOf(node.state), ...node.children.map(rank));
  const recent = node => Math.max(node.seenAt || 0, node.lastActivityAt || 0, ...node.children.map(recent));
  const order = list => list.sort((a, b) => rank(a) - rank(b) || recent(b) - recent(a) || a.id.localeCompare(b.id)).forEach(n => order(n.children));
  order(roots);
  for (const node of roots) node.group = STATES[rank(node)];
  return roots;
}

// True when id is parentId or one of its ancestors, which would make a cycle.
function isAncestor(byId, id, parentId) {
  for (let at = parentId, seen = 0; at && seen < 50; seen++) {
    if (at === id) return true;
    at = byId.get(at)?.parent;
  }
  return false;
}
