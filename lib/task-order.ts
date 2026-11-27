// Task priority and list order, shared by the store, CLI, MCP, render and the board; no node imports, so the web bundle can use it.
export const TASK_PRIORITIES = ["P0", "P1", "P2", "P3"];
export const TASK_PRIORITY_DEFAULT = "P2";
// Within one priority: work in flight first (including builds waiting for review), then queued (open and decided
// share a rank), then finished.
export const SORT_STATUSES = ["building", "review", "blocked", "open", "decided", "done"];
// oxlint-disable-next-line quality/no-known-value-widening -- looked up by a runtime status string
const STATUS_RANK: Record<string, number> = { building: 0, review: 0, blocked: 1, open: 2, decided: 2, done: 3 };

/** The fields ordering reads; stored tasks carry more. */
export type Sortable = { priority?: unknown; status?: string; updated?: number };

function rank(list: string[], value: string): number {
  const at = list.indexOf(value);
  return at < 0 ? list.length : at;
}

/** The task's priority: its own when valid, else P2 (a missing priority means P2). */
export function priorityOf(task: Sortable | null | undefined): string {
  return TASK_PRIORITIES.includes(task?.priority as string) ? task?.priority as string : TASK_PRIORITY_DEFAULT;
}

/** Priority alone, P0 first; 0 when the two tasks share one. */
export function comparePriority(a: Sortable, b: Sortable): number {
  return rank(TASK_PRIORITIES, priorityOf(a)) - rank(TASK_PRIORITIES, priorityOf(b));
}

/** Priority, then status (building/review, blocked, open/decided, done), then most recently updated first. */
export function compareTasks(a: Sortable, b: Sortable): number {
  const byPriority = comparePriority(a, b);
  if (byPriority) return byPriority;
  const byStatus = (STATUS_RANK[a.status ?? ""] ?? SORT_STATUSES.length) - (STATUS_RANK[b.status ?? ""] ?? SORT_STATUSES.length);
  if (byStatus) return byStatus;
  return (b.updated ?? 0) - (a.updated ?? 0);
}

/** A sorted copy of the tasks; the input is left alone. */
export function sortTasks<T extends Sortable>(tasks: T[]): T[] {
  return [...tasks].sort(compareTasks);
}
