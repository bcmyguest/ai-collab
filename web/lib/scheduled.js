// Detail rows for a scheduled job: one row per field the runner reports, none invented.

/** "every 30 min" for an interval in milliseconds. */
export function everyLabel(everyMs) {
  return "every " + everyMs / 60_000 + " min";
}

/** The agent address a job's command resumes (`cursor#<16 hex>`), or "" when it resumes none. */
export function jobAgent(job) {
  const resumed = job?.session;
  return resumed?.harness && resumed?.session ? resumed.harness + "#" + resumed.session : "";
}

/** [label, value] rows for the job's detail sheet; a field the runner did not send gets no row. */
export function jobDetail(job) {
  const rows = [["Schedule", everyLabel(job.everyMs)]];
  if (job.nextRun) rows.push(["Next run", job.nextRun]);
  if (Array.isArray(job.command) && job.command.length) rows.push(["Command", job.command.join(" ")]);
  if (job.cwd) rows.push(["Folder", job.cwd]);
  if (job.last?.status) rows.push(["Last run", job.last.status]);
  // The job is the schedule, not the agent: the agent it resumes is a separate entry in the sidebar.
  if (jobAgent(job)) rows.push(["Resumes", jobAgent(job)]);
  return rows;
}

// A quarter hour of slack on each side of a run: the session's hook rows and the run's clock are not the same clock.
export const RUN_WINDOW_SLACK_MS = 15 * 60_000;

/**
 * The [from, to] window (epoch ms) of each run in a list, keyed by run id. The window is the run's own lifetime plus
 * RUN_WINDOW_SLACK_MS either side, cut at the midpoint to the neighbouring run of the same schedule so two runs never
 * show the same rows. A run with no start time gets no window.
 */
export function runWindows(runs = []) {
  const ordered = runs.filter(run => Number.isSafeInteger(run?.startedAt)).slice().sort((a, b) => a.startedAt - b.startedAt);
  const windows = new Map();
  ordered.forEach((run, i) => {
    const previous = ordered[i - 1];
    const next = ordered[i + 1];
    const end = run.finishedAt ?? run.updatedAt ?? run.startedAt;
    // Never reach past the midpoint to a neighbour, so a 30-minute schedule's back-to-back runs stay apart.
    const from = Math.max(run.startedAt - RUN_WINDOW_SLACK_MS, previous ? Math.ceil((previous.startedAt + run.startedAt) / 2) : -Infinity);
    const to = Math.min(end + RUN_WINDOW_SLACK_MS, next ? Math.floor((run.startedAt + next.startedAt) / 2) : Infinity);
    windows.set(run.id, { from, to });
  });
  return windows;
}

/**
 * The session and time window one schedule run covers: {harness, session, project, from, to}, or null when the runner
 * named no session or the run has no window. With the schedule's whole run list the window is clamped as runWindows does.
 */
export function runWindow(run, project = "", runs = []) {
  const session = run?.session;
  if (!session?.harness || !session.session || !Number.isSafeInteger(run.startedAt)) return null;
  const window = runWindows(runs.length ? runs : [run]).get(run.id);
  if (!window || window.to <= window.from) return null;
  return { project: run.project || project, harness: session.harness, session: session.harness + "#" + session.session, ...window };
}

/** The UI hash that opens one run's slice of its session's timeline, or "" when the runner named no session. */
export function runLink(run, project = "", runs = []) {
  const found = runWindow(run, project, runs);
  if (!found) return "";
  const params = new URLSearchParams({
    project: found.project, level: "session", harness: found.harness, session: found.session,
    tab: "activity", from: String(found.from), to: String(found.to),
  });
  return "#" + params;
}

/** "2:05 PM" for a run's start, "" when it has none. */
export function runLabel(run) {
  return Number.isSafeInteger(run?.startedAt) ? new Date(run.startedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
}
