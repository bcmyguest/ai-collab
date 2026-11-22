// The task board for the UI snapshot: each task with its owner's presence and its last progress line.

/** Tasks of a project backend; an unreadable store reports its error instead of tasks. */
export function taskBoard(backend, agents = [], runs = [], sessions = [], previousBuilder = () => null, assignment) {
  if (!backend) return { tasks: [] };
  let list;
  try {
    list = backend.list();
  } catch (err) {
    return { tasks: [], error: err.message };
  }
  const owners = new Map(agents.map(agent => [agent.id, agent]));
  const runOf = new Map(runs.map(run => [run.id, run.sessions?.[run.active] || ""]));
  const sessionOf = new Map();
  for (const session of sessions) {
    if (!session.taskId || session.status === "ended") continue;
    const previous = sessionOf.get(session.taskId);
    if (!previous || session.createdAt > previous.createdAt) sessionOf.set(session.taskId, session);
  }
  return {
    tasks: list.map(task => {
      const owner = task.owner || sessionOf.get(task.id)?.address;
      const previous = previousBuilder(task);
      const continuation = previous && !sessions.some(session => session.status !== "ended"
        && (session.cwd === previous.worktree || session.address === owner));
      return {
        ...(continuation ? { previousHarness: (owner || previous.address)?.split("#")[0] || previous.harness } : {}),
        id: task.id,
        title: task.title,
        ...(task.priority ? { priority: task.priority } : {}),
        ...(owner && !task.owner ? { inferredOwner: true } : {}),
        status: task.status,
        ...(task.detail ? { detail: task.detail } : {}),
        blockers: task.blockers,
        ...(owner ? { owner, ownerOnline: owners.get(owner)?.online === true } : {}),
        ...(task.status === "building" && owner && owners.get(owner)?.runningJobs > 0
          ? { ownerRunningJobs: owners.get(owner).runningJobs } : {}),
        ...(task.run ? { run: task.run } : {}),
        // The graph opens the run's active session when the task has no owner.
        ...(runOf.get(task.run) ? { runSession: runOf.get(task.run) } : {}),
        last: task.progress.at(-1) ?? null,
        ...(task.question ? { question: task.question } : {}),
        updated: task.updated,
        ...assignment?.(task, sessions),
      };
    }),
  };
}