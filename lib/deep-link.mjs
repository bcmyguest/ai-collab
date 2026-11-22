// UI deep links: the hash parameters web/lib/selection.js reads, on the base URL in AI_COLLAB_UI_URL.
export function uiBase(env = process.env) {
  const value = String(env.AI_COLLAB_UI_URL || "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s/]+(\/\S*)?$/.test(value) ? value : "";
}

/** A UI link to a project's chat, a session's thread, or one of its subagent runs; "" without a base URL. */
export function deepLink({ base = uiBase(), project, session = "", run = "" } = {}) {
  if (!base || !project) return "";
  const params = new URLSearchParams({ project, level: session ? "session" : "project" });
  if (session) {
    params.set("harness", session.split("#")[0]);
    params.set("session", session);
  }
  if (run) {
    params.set("tab", "subagents");
    params.set("run", run);
  }
  return `${base}/#${params}`;
}
