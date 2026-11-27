// Starts a schedule's tick early when a task in a project's store moves to done or blocked, so the PM hands off the next task at once.
import { readStore, taskStoreFile } from "../lib/tasks.ts";

type Log = (line: string) => void;
type Wake = (ids: string[]) => Promise<boolean>;
type ScheduleEntry = { name: string; wakeOnTasks?: string };
type ScheduleRunner = { runSchedule: (name: string, reason: string) => Promise<{ status: string }> };

export const TASK_WAKE_EVERY_MS = 15_000;
const FINISHED = new Set(["done", "blocked"]);

/** Polls the task store; calls wake(ids) for tasks newly done or blocked, and retries until wake returns true. Returns stop(). */
export function watchTaskFinishes({ file, wake, log = () => {}, everyMs = TASK_WAKE_EVERY_MS }: { file: string; wake: Wake; log?: Log; everyMs?: number }): () => void {
  let last: Map<string, string> | null = null;
  let pending: string[] = [];
  const statuses = () => new Map<string, string>(readStore(file).tasks.map((task) => [task.id, task.status]));
  const tick = async () => {
    let now: Map<string, string>;
    try { now = statuses(); } catch (error) { log(`task wake: ${(error as Error).message}`); return; }
    if (last) for (const [id, status] of now) if (FINISHED.has(status) && last.get(id) !== status && !pending.includes(id)) pending.push(id);
    last = now;
    if (!pending.length) return;
    let started = false;
    try { started = await wake(pending) === true; } catch (error) { log(`task wake: ${(error as Error).message}`); }
    if (started) pending = [];
  };
  void tick();
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** Watches each schedule entry's wakeOnTasks project and runs that schedule now when one of its tasks finishes. */
export function startTaskWakes(entries: ScheduleEntry[], runner: ScheduleRunner, { env = process.env, log = () => {}, everyMs }: { env?: NodeJS.ProcessEnv; log?: Log; everyMs?: number } = {}): Array<() => void> {
  return entries.filter((entry) => entry.wakeOnTasks).map((entry) => watchTaskFinishes({
    file: taskStoreFile(entry.wakeOnTasks as string, env),
    everyMs,
    log,
    wake: async (ids) => {
      try {
        const result = await runner.runSchedule(entry.name, "task-wake");
        log(`task wake: ${ids.join(", ")} finished; ${entry.name} ${result.status}`);
        return result.status === "started";
      } catch (error) {
        log(`task wake: ${entry.name} not started: ${(error as Error).message}`);
        return false;
      }
    },
  }));
}
