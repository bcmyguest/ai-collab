// The task board for the UI snapshot: each task with its owner's presence and its last progress line.

/** Tasks of a project backend; an unreadable store reports its error instead of tasks. */
export function taskBoard(backend, agents = [], runs = []) {
  if (!backend) return { tasks: [] };
  let list;
  try {
    list = backend.list();
  } catch (err) {
    return { tasks: [], error: err.message };
  }
  const owners = new Map(agents.map(agent => [agent.id, agent]));
  const runOf = new Map(runs.map(run => [run.id, run.sessions?.[run.active] || ""]));
  return {
    tasks: list.map(task => ({
      id: task.id,
      title: task.title,
      ...(task.priority ? { priority: task.priority } : {}),
      status: task.status,
      ...(task.detail ? { detail: task.detail } : {}),
      blockers: task.blockers,
      ...(task.owner ? { owner: task.owner, ownerOnline: owners.get(task.owner)?.online === true } : {}),
      ...(task.status === "building" && task.owner && owners.get(task.owner)?.runningJobs > 0
        ? { ownerRunningJobs: owners.get(task.owner).runningJobs } : {}),
      ...(task.run ? { run: task.run } : {}),
      // The graph opens the run's active session when the task has no owner.
      ...(runOf.get(task.run) ? { runSession: runOf.get(task.run) } : {}),
      last: task.progress.at(-1) ?? null,
      updated: task.updated,
    })),
  };
}
