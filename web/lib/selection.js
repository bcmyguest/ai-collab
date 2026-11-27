import { isTaskId } from "./task-tags.js";

// Location hash → console selection: the level, project, session, view tab and subagent run a URL names.
export const LEVELS = [["project", "Project"], ["session", "Sessions"], ["tasks", "Tasks"], ["patterns", "Teams"], ["compactions", "Compactions"]];
// Views each level accepts in the hash: a session's chat alone (activity), or beside its subagents, raw activity, diff or PR panel.
export const TABS = { project: [], session: ["activity", "subagents", "raw", "diff", "pr"], tasks: [], patterns: [] };

/**
 * The hash (without "#") for a selection; the inverse of parseSelection for the keys it keeps.
 * The patterns level carries the pattern, raw flag, run, the team editor (edit) and the author composer (author).
 */
export function selectionHash(next = {}) {
  if (next.level === "home" || next.level === "inbox") return next.level;
  const params = new URLSearchParams();
  for (const key of ["project", "level", "harness", "session"]) if (next[key]) params.set(key, next[key]);
  if ((TABS[next.level || "project"] || []).includes(next.tab)) params.set("tab", next.tab);
  if (next.tab === "subagents" && next.run) params.set("run", next.run);
  if (next.level === "patterns") {
    for (const key of ["pattern", "run"]) if (next[key]) params.set(key, next[key]);
    if (next.raw) params.set("raw", "1");
    if (next.edit) params.set("edit", next.edit);
    if (next.author) params.set("author", "1");
    if (next.edit && next.authorName) params.set("authorName", next.authorName);
  }
  if (next.level === "tasks" && isTaskId(next.task)) params.set("task", next.task);
  if (next.level === "project" && isTaskId(next.composeTask)) params.set("composeTask", next.composeTask);
  return params.toString();
}

/**
 * The badge counts a project's views show: every task and how many of them wait on the operator's decision, and the
 * number of patterns and teams.
 */
export function projectViewCounts(data = {}) {
  const tasks = data.tasks?.tasks || [];
  const waiting = tasks.filter(task => task.question && !task.question.answer).length;
  return { tasks: tasks.length, waiting, patterns: (data.patterns || []).length };
}

/** The selection named by a hash without its "#"; an empty hash, home, or level=home is the Home overview. */
export function parseSelection(hash) {
  const params = new URLSearchParams(hash);
  const level = params.get("level");
  if (!hash || params.has("home") || level === "home") return { project: "", level: "home", harness: "", session: "", tab: "chat", run: "" };
  if (params.has("inbox") || level === "inbox") return { project: "", level: "inbox", harness: "", session: "", tab: "chat", run: "" };
  const tab = params.get("tab");
  // An old link to the board (level=project&tab=tasks) opens the Tasks level.
  const named = level === "project" && tab === "tasks" ? "tasks" : level;
  const at = LEVELS.some(([id]) => id === named) ? named : "project";
  // Old links with tab=chat or tab=activity open a session's timeline.
  const sessionTab = TABS.session.includes(tab) ? tab : "activity";
  const base = {
    project: params.get("project") || "",
    level: at,
    harness: params.get("harness") || "",
    session: params.get("session") || "",
    tab: at === "session" ? sessionTab : "chat",
    run: at === "session" && tab === "subagents" ? params.get("run") || "" : "",
  };
  // pattern names the one inspected, raw=1 shows its definition text; edit=1 opens its team editor, edit=new a new team;
  // author=1 opens the describe-a-team composer; authorName carries the name typed there into a new editor; run names a run.
  if (at === "patterns") {
    const edit = params.get("edit") || "";
    return {
      ...base, pattern: params.get("pattern") || "", raw: params.get("raw") === "1", ...(edit ? { edit } : {}),
      ...(params.get("author") === "1" ? { author: true } : {}), ...(edit && params.get("authorName") ? { authorName: params.get("authorName") } : {}),
      run: params.get("run") || "",
    };
  }
  if (at === "tasks" && isTaskId(params.get("task"))) return { ...base, task: params.get("task") };
  if (at === "project" && isTaskId(params.get("composeTask"))) return { ...base, composeTask: params.get("composeTask") };
  // from/to (epoch ms) cut a session's timeline to one schedule run; no other session tab reads them.
  const window = at === "session" && base.tab === "activity" ? timeWindow(params) : null;
  return window ? { ...base, window } : base;
}

// The {from, to} range a hash names, or null when a bound is missing, out of order or not a positive epoch time.
function timeWindow(params) {
  const from = Number(params.get("from"));
  const to = Number(params.get("to"));
  return Number.isSafeInteger(from) && Number.isSafeInteger(to) && from > 0 && to >= from ? { from, to } : null;
}
