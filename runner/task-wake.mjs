// Starts a schedule's tick early when a task in a project's store moves to done or blocked, so the PM hands off the next task at once.
import { readStore, taskStoreFile } from "../lib/tasks.mjs";

export const TASK_WAKE_EVERY_MS = 15_000;
const FINISHED = new Set(["done", "blocked"]);

/** Polls the task store; calls wake(ids) for tasks newly done or blocked, and retries until wake returns true. Returns stop(). */
export function watchTaskFinishes({ file, wake, log = () => {}, everyMs = TASK_WAKE_EVERY_MS }) {
  let last = null;
  let pending = [];
  const statuses = () => new Map(readStore(file).tasks.map((task) => [task.id, task.status]));
  const tick = () => {
    let now;
    try { now = statuses(); } catch (error) { log(`task wake: ${error.message}`); return; }
    if (last) for (const [id, status] of now) if (FINISHED.has(status) && last.get(id) !== status && !pending.includes(id)) pending.push(id);
    last = now;
    if (!pending.length) return;
    let started = false;
    try { started = wake(pending) === true; } catch (error) { log(`task wake: ${error.message}`); }
    if (started) pending = [];
  };
  tick();
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** Watches each schedule entry's wakeOnTasks project and runs that schedule now when one of its tasks finishes. */
export function startTaskWakes(entries, runner, { env = process.env, log = () => {}, everyMs } = {}) {
  return entries.filter((entry) => entry.wakeOnTasks).map((entry) => watchTaskFinishes({
    file: taskStoreFile(entry.wakeOnTasks, env),
    everyMs,
    log,
    wake: (ids) => {
      try {
        const result = runner.runSchedule(entry.name, "task-wake");
        log(`task wake: ${ids.join(", ")} finished; ${entry.name} ${result.status}`);
        return result.status === "started";
      } catch (error) {
        log(`task wake: ${entry.name} not started: ${error.message}`);
        return false;
      }
    },
  }));
}
