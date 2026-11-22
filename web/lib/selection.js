// Location hash → console selection: the level, project, session, view tab and subagent run a URL names.
export const LEVELS = [["project", "Project"], ["session", "Sessions"], ["patterns", "Patterns and teams"], ["compactions", "Compactions"]];
// Views each level accepts in the hash: a session's timeline (activity), its subagents and raw activity; the project has one chat.
export const TABS = { project: [], session: ["activity", "subagents", "raw"], patterns: [] };

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
    tab: at === "session" ? sessionTab : "chat",
    run: at === "session" && tab === "subagents" ? params.get("run") || "" : "",
  };
  // pattern names the one inspected, raw=1 shows its definition text; run names a pattern run.
  if (at === "patterns") return { ...base, pattern: params.get("pattern") || "", raw: params.get("raw") === "1", run: params.get("run") || "" };
  return base;
}
