// Detail rows for a scheduled job: one row per field the runner reports, none invented.

/** "every 30 min" for an interval in milliseconds. */
export function everyLabel(everyMs) {
  return "every " + everyMs / 60_000 + " min";
}

/** [label, value] rows for the job's detail sheet; a field the runner did not send gets no row. */
export function jobDetail(job) {
  const rows = [["Schedule", everyLabel(job.everyMs)]];
  if (job.nextRun) rows.push(["Next run", job.nextRun]);
  if (Array.isArray(job.command) && job.command.length) rows.push(["Command", job.command.join(" ")]);
  if (job.cwd) rows.push(["Folder", job.cwd]);
  if (job.last?.status) rows.push(["Last run", job.last.status]);
  return rows;
}
