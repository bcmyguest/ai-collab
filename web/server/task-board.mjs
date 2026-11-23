// The task board for the UI snapshot: each task with its owner's presence, its last progress line and its review packet.

import { reviewIsCurrent } from "../../lib/build-review.mjs";

// The board renders every card on each push; one branch-tip read per checkout per window is enough for a stale badge.
const TIP_TTL_MS = 2000;

/** The review packet a card and its review view read; `stale` and the diff link are derived, never stored. */
function reviewOf(task, context) {
  const packet = task.review;
  if (!context || !packet) return undefined;
  return {
    submission: packet.submission, commit: packet.commit, base: packet.base, branch: packet.branch,
    criteria: packet.criteria, check: packet.check, files: packet.files,
    insertions: packet.insertions, deletions: packet.deletions, more: packet.more, at: packet.at,
    ...(packet.decision ? { decision: packet.decision } : {}),
    stale: !reviewIsCurrent(context.root, packet, { ttlMs: TIP_TTL_MS }),
    diff: "/api/review-diff?" + new URLSearchParams({ project: context.project, id: task.id, submission: packet.submission }),
  };
}

/** Tasks of a project backend; an unreadable store reports its error instead of tasks. */
export function taskBoard(backend, agents = [], runs = [], sessions = [], previousBuilder = () => null, assignment, reviewContext) {
  if (!backend) return { tasks: [] };
  let list, outcomes;
  try {
    ({ tasks: list, outcomes } = backend.projectBoard ? backend.projectBoard() : { tasks: backend.list() });
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
    ...(outcomes ? { outcomes } : {}),
    tasks: list.map(task => {
      const owner = task.owner || sessionOf.get(task.id)?.address;
      const previous = previousBuilder(task);
      const continuation = previous && !sessions.some(session => session.status !== "ended"
        && (session.cwd === previous.worktree || session.address === owner));
      const review = reviewOf(task, reviewContext);
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
        ...(review ? { review } : {}),
        updated: task.updated,
        ...assignment?.(task, sessions),
      };
    }),
  };
}
