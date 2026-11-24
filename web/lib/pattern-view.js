// Pattern list, inspect and run views: which actions a listed entry allows, and what a run can take next.
export const SCOPE_LABELS = { "built-in": "built-in", global: "global", project: "project", team: "team", other: "other project" };

/** Delete is offered for the project's own patterns and teams: the server's removable flag (global teams live in teams.json). */
export function canDelete(pattern) {
  return pattern.removable === true;
}

/** Built-in, global, and another project's team copy into this project. */
export function canCopy(source) {
  return source === "built-in" || source === "global" || source === "other";
}

/** The events the active role of a run can send, in handoff order. Empty once the run is not running. */
export function pendingEvents(run) {
  if (run?.status !== "running") return [];
  return (run.definition?.handoffs ?? []).filter(handoff => handoff.from === run.active).map(handoff => handoff.on);
}

/** Runs of one pattern, newest first (listRuns order is kept). */
export function runsOf(runs, name) {
  return (runs ?? []).filter(run => run.pattern === name);
}

/** One line per handoff for the run log. */
export function handoffLine(handoff) {
  return `${handoff.seq}. ${handoff.from} → ${handoff.to} "${handoff.on}"${handoff.override ? " (operator)" : ""}`;
}

/** How many times each handoff (from, to, on) fired in a run; returns a counter for one handoff. */
export function firedCounts(run) {
  const counts = new Map();
  for (const handoff of run?.handoffs ?? []) {
    const key = `${handoff.from}\n${handoff.to}\n${handoff.on}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return (handoff) => counts.get(`${handoff.from}\n${handoff.to}\n${handoff.on}`) ?? 0;
}
