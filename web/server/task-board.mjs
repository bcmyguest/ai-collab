// The task board for the UI snapshot: each task with its owner's presence and its last progress line.
import { readTasks } from "../../lib/tasks.mjs";

/** Tasks of the project at root; an unreadable store reports its error instead of tasks. */
export function taskBoard(root, agents = [], runs = []) {
  if (!root) return { tasks: [] };
  let doc;
  try {
    doc = readTasks(root);
  } catch (err) {
    return { tasks: [], error: err.message };
  }
  const online = new Map(agents.map(agent => [agent.id, agent.online === true]));
  const runOf = new Map(runs.map(run => [run.id, run.sessions?.[run.active] || ""]));
  return {
    tasks: doc.tasks.map(task => ({
      id: task.id,
      title: task.title,
      status: task.status,
      ...(task.detail ? { detail: task.detail } : {}),
      blockers: task.blockers,
      ...(task.owner ? { owner: task.owner, ownerOnline: online.get(task.owner) === true } : {}),
      ...(task.run ? { run: task.run } : {}),
      // The address of the run's active role: the session a card opens when it has no owner.
      ...(runOf.get(task.run) ? { runSession: runOf.get(task.run) } : {}),
      last: task.progress.at(-1) ?? null,
      updated: task.updated,
    })),
  };
}
