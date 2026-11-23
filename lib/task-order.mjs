// Task priority and list order, shared by the store, CLI, MCP, render and the board; no node imports, so the web bundle can use it.
export const TASK_PRIORITIES = ["P0", "P1", "P2", "P3"];
export const TASK_PRIORITY_DEFAULT = "P2";
// Within one priority: work in flight first (including builds waiting for review), then queued (open and decided
// share a rank), then finished.
export const SORT_STATUSES = ["building", "review", "blocked", "open", "decided", "done"];
const STATUS_RANK = { building: 0, review: 0, blocked: 1, open: 2, decided: 2, done: 3 };

function rank(list, value) {
  const at = list.indexOf(value);
  return at < 0 ? list.length : at;
}

/** The task's priority: its own when valid, else P2 (a missing priority means P2). */
export function priorityOf(task) {
  return TASK_PRIORITIES.includes(task?.priority) ? task.priority : TASK_PRIORITY_DEFAULT;
}

/** Priority alone, P0 first; 0 when the two tasks share one. */
export function comparePriority(a, b) {
  return rank(TASK_PRIORITIES, priorityOf(a)) - rank(TASK_PRIORITIES, priorityOf(b));
}

/** Priority, then status (building/review, blocked, open/decided, done), then most recently updated first. */
export function compareTasks(a, b) {
  const byPriority = comparePriority(a, b);
  if (byPriority) return byPriority;
  const byStatus = (STATUS_RANK[a.status] ?? SORT_STATUSES.length) - (STATUS_RANK[b.status] ?? SORT_STATUSES.length);
  if (byStatus) return byStatus;
  return (b.updated ?? 0) - (a.updated ?? 0);
}

/** A sorted copy of the tasks; the input is left alone. */
export function sortTasks(tasks) {
  return [...tasks].sort(compareTasks);
}
