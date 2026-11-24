// Pure session-state helpers shared by the UI server (ui.mjs), the Home and Sessions views, and their tests.
import { runState } from "./activity-rows.js";

export const RECENT_MS = 60_000;
export const WORKING_MS = 15 * 60_000;
// An offline session silent this long is dead: the list keeps it folded behind a tap.
export const DEAD_MS = 24 * 60 * 60_000;
export const STATES = ["waiting", "afk", "working", "idle", "offline"];
export const STATE_LABELS = { waiting: "Waiting on you", afk: "AFK hold", working: "Working", idle: "Idle", offline: "Offline" };
const FIRST_WORDS = 6;

/** The card's online dot. A stopped OpenCode session is offline while the shared server process stays up. */
export function shownOnline(s) {
  if (!s?.online) return false;
  if (s.harness === "opencode" && /^(stop|sessionend|ended)$/i.test(s.event || "")) return false;
  return true;
}

/** True when a pending item the operator can answer in the UI is open: blocking and not expired. */
export function waitingOn(pending, now) {
  return (pending || []).some(p => p.blocking && !(p.expiresAt && p.expiresAt < now));
}

/**
 * State of one session card from server facts:
 * waiting (an open approval, choice or important question), afk (its Stop hook holds the turn in AFK mode),
 * working (a running job, an open tool call under 15 min old, a running subagent, or activity in the last 60 s), idle (online), else offline.
 */
export function sessionState(s, now) {
  if (waitingOn(s.pending, now)) return "waiting";
  if (s.runningJobs > 0) return "working";
  if (shownOnline(s) && s.afkHold) return "afk";
  if (s.openCallAt && now - s.openCallAt < WORKING_MS) return "working";
  if (s.lastActivityAt && now - s.lastActivityAt < RECENT_MS) return "working";
  if (s.subagents?.some(run => runState(run, now) === "running")) return "working";
  return shownOnline(s) ? "idle" : "offline";
}

/** The wake to show for a session, or null once it reported after the wake began or the wake is no longer running. */
/** A project's sessions as running (online) and inactive (offline) counts for its sidebar row. */
export function sessionCounts(agents) {
  const running = agents.filter(shownOnline).length;
  return { running, inactive: agents.length - running };
}

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

/** When the card, or any session nested under it, was last active (ms). */
export function lastSeenAt(node) {
  return Math.max(node.seenAt || 0, node.lastActivityAt || 0, ...(node.children || []).map(lastSeenAt));
}

/** A card offline for a day is dead: still listed, but behind one tap so live work stays on screen. */
export function isDead(node, now) {
  return (node.group || node.state) === "offline" && now - lastSeenAt(node) >= DEAD_MS;
}

/** Cards ordered by state, then newest activity; children whose parent is listed nest under it and lift its group. */
export function sessionTree(sessions, now, { separateOffline = false } = {}) {
  const byId = new Map(sessions.map(s => [s.id, { ...s, state: sessionState(s, now), children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    const parent = node.parent && node.parent !== node.id ? byId.get(node.parent) : null;
    if (parent && (!separateOffline || (node.state === "offline") === (parent.state === "offline")) && !isAncestor(byId, node.id, parent.id)) parent.children.push(node);
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
