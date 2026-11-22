import { isTaskId } from "./task-tags.js";

// Location hash → console selection: the level, project, session, view tab and subagent run a URL names.
export const LEVELS = [["project", "Project"], ["session", "Sessions"], ["tasks", "Tasks"], ["patterns", "Patterns and teams"], ["compactions", "Compactions"]];
// Views each level accepts in the hash: a session's timeline (activity), its subagents and raw activity; nothing else.
export const TABS = { project: [], session: ["activity", "subagents", "raw"], tasks: [], patterns: [] };

/** The selection named by a hash without its "#"; an empty hash, home, or level=home is the Home overview. */
export function parseSelection(hash) {
  const params = new URLSearchParams(hash);
  const level = params.get("level");
  if (!hash || params.has("home") || level === "home") return { project: "", level: "home", harness: "", session: "", tab: "chat", run: "" };
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
  // pattern names the one inspected, raw=1 shows its definition text; edit=1 opens its team editor, edit=new a new team; run names a pattern run.
  if (at === "patterns") return { ...base, pattern: params.get("pattern") || "", raw: params.get("raw") === "1", ...(params.get("edit") ? { edit: params.get("edit") } : {}), run: params.get("run") || "" };
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
