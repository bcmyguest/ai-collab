// Pure subagent-run state for the Subagents view: running, finished or stale.
export const STALE_MS = 10 * 60_000;
export const SUBAGENT_LABELS = { running: "Running", finished: "Finished", stale: "Stale" };

/** finished when a stop was seen (run.done); else running with activity in the last 10 min, else stale. */
export function subagentState(run, now) {
  if (run.done) return "finished";
  return now - (run.lastTime ?? run.time) * 1000 < STALE_MS ? "running" : "stale";
}
