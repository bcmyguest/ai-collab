// Task board view model: status columns, the status filter and relative ages.
import { sortTasks } from "../../lib/task-order.mjs";

export const COLUMNS = ["open", "decided", "building", "review", "blocked", "done"];
export const FILTERS = ["all", ...COLUMNS];
// The stored status stays "decided"; the UI calls it Ready, the operator approved it and a builder has not started.
export const STATUS_LABEL = { open: "open", decided: "Ready", building: "building", review: "Review", blocked: "blocked", done: "done" };

/** [status, tasks] per column in column order, each sorted by priority; a filter other than "all" keeps one column. */
export function columnsOf(tasks, filter = "all") {
  const shown = filter === "all" ? COLUMNS : [filter];
  return shown.map(status => [status, sortTasks(tasks.filter(task => task.status === status))]);
}

/** {status: count} for every status, so the filter row does not rescan the list once per status. */
export function countsOf(tasks) {
  const counts = Object.fromEntries(COLUMNS.map(status => [status, 0]));
  for (const task of tasks) if (counts[task.status] !== undefined) counts[task.status] += 1;
  return counts;
}

/** The label a column or filter shows for a status: "Ready" for decided, the status itself otherwise. */
export function statusLabel(status) {
  return STATUS_LABEL[status] ?? status;
}

/** The age of a timestamp in the largest whole unit: "12s", "5m", "3h", "2d". */
export function ageOf(at, now) {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/**
 * The clock the board renders at: the finest unit any card's age prints. A card under a minute prints seconds, so the
 * board follows the real clock; otherwise the clock is rounded down to the minute, hour or day it prints, which leaves
 * every age string exact while a per-second tick no longer touches a single column.
 */
export function boardClock(tasks, now) {
  let finest = 86_400_000;
  for (const task of tasks) {
    const at = task.last?.at;
    if (!Number.isSafeInteger(at)) continue;
    const seconds = Math.max(0, Math.floor((now - at) / 1000));
    const unit = seconds < 60 ? 1 : seconds < 3600 ? 60_000 : seconds < 86400 ? 3_600_000 : 86_400_000;
    if (unit < finest) finest = unit;
    if (finest === 1) return now;
  }
  return Math.floor(now / finest) * finest;
}
