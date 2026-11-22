// Location hash → console selection: the level, project, session, view tab and subagent run a URL names.
export const LEVELS = [["project", "Project"], ["session", "Sessions"], ["patterns", "Patterns and teams"], ["compactions", "Compactions"]];
// Views each level accepts in the hash: a session's timeline (activity), its subagents and raw activity; the project has its chat and the task board.
export const TABS = { project: ["tasks"], session: ["activity", "subagents", "raw"], patterns: [] };

/**
 * The hash (without "#") for a selection; the inverse of parseSelection for the keys it keeps.
 * The patterns level carries the pattern, raw flag, run, the team editor (edit) and the author composer (author).
 */
export function selectionHash(next = {}) {
  if (next.level === "home") return "home";
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
  return params.toString();
}

/** The selection named by a hash without its "#"; an empty hash, home, or level=home is the Home overview. */
export function parseSelection(hash) {
  const params = new URLSearchParams(hash);
  const level = params.get("level");
  if (!hash || params.has("home") || level === "home") return { project: "", level: "home", harness: "", session: "", tab: "chat", run: "" };
  const tab = params.get("tab");
  const at = LEVELS.some(([id]) => id === level) ? level : "project";
  // Old links with tab=chat or tab=activity open a session's timeline.
  const sessionTab = TABS.session.includes(tab) ? tab : "activity";
  const base = {
    project: params.get("project") || "",
    level: at,
    harness: params.get("harness") || "",
    session: params.get("session") || "",
    tab: at === "session" ? sessionTab : tab === "tasks" ? "tasks" : "chat",
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
  return base;
}
