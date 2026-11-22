// Task board view model: status columns, the status filter and relative ages.
export const COLUMNS = ["open", "decided", "building", "blocked", "done"];
export const FILTERS = ["all", ...COLUMNS];

/** [status, tasks] per column in column order, store order inside a column; a filter other than "all" keeps one column. */
export function columnsOf(tasks, filter = "all") {
  const shown = filter === "all" ? COLUMNS : [filter];
  return shown.map(status => [status, tasks.filter(task => task.status === status)]);
}

/** The age of a timestamp in the largest whole unit: "12s", "5m", "3h", "2d". */
export function ageOf(at, now) {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
