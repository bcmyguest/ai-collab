// Pure subagent-run state for the Subagents view: running, finished or stale.
import { runState } from "./activity-rows.js";

export const STALE_MS = 10 * 60_000;
export const IDLE_HIDE_MS = 30 * 60_000;
export const SUBAGENT_LABELS = { running: "Running", finished: "Finished", stale: "Stale" };

/** finished when a stop was seen (run.done); else running with activity in the last 10 min, else stale. */
export function subagentState(run, now) {
  if (run.done) return "finished";
  return now - (run.lastTime ?? run.time) * 1000 < STALE_MS ? "running" : "stale";
}

/** Count of runs the browser counts as running (runState). */
export function runningCount(runs, now) {
  return runs.filter(run => runState(run, now) === "running").length;
}

/** Runs to show, and the idle ones older than IDLE_HIDE_MS that the "Show N idle" toggle hides. */
export function splitIdleRuns(runs, now) {
  const hidden = run => runState(run, now) !== "running" && now - (run.lastTime ?? run.time) * 1000 > IDLE_HIDE_MS;
  return { shown: runs.filter(run => !hidden(run)), idle: runs.filter(hidden) };
}
