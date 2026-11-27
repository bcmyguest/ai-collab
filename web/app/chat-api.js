// The console's network layer: the POST helper, the build check, the auth ping, and what each hash selection streams.
import { toast } from "sonner";
import { parseSelection } from "@/lib/selection";
import { SEND_CONFIRMATION, readSendConfirmation } from "@/lib/send-confirmation";

export const initial = { projects: [], harnesses: [], agents: [], messages: [] };
export const CONNECTION_TOAST = "connection";
export const UPDATE_TOAST = "update";
export const BUILD = process.env.AI_COLLAB_BUILD;
// Fired on a 401 or a closed stream; the sign-in gate asks /api/auth/me again.
export const AUTH_CHECK = "ai-collab:auth-check";

export function selection() {
  return parseSelection(location.hash.slice(1));
}

/** The /api/events query for a selection, and which view it shows. */
export function streamOf(selected) {
  const stream = new URLSearchParams();
  const home = selected.level === "home" || selected.level === "inbox";
  const session = selected.level === "session" && Boolean(selected.session);
  if (selected.project && !home) stream.set("project", selected.project);
  if (session) stream.set("session", selected.session);
  // The project chat reads activity for its completion and live rows; a session's chat and its side panels read it too.
  const watching = selected.level === "project";
  const subagents = session && selected.tab === "subagents";
  // A session always shows its chat; the tab picks the panel beside it.
  const inline = session;
  const raw = session && selected.tab === "raw";
  // Sessions with none picked lists the project's sessions under the selector.
  const listing = selected.level === "session" && !selected.session;
  // The task board: its own sidebar level, read from the same project stream as the chat.
  const tasks = selected.level === "tasks";
  // The compaction map reads each agent's compactions and context from the sessions view.
  const compactions = selected.level === "compactions";
  if (watching || inline || subagents || raw) stream.set("view", "activity");
  else if (home) stream.set("view", "home");
  else if (listing || compactions) stream.set("view", "sessions");
  if (compactions) stream.set("history", "1");
  return { home, watching, subagents, inline, raw, listing, tasks, compactions, requested: stream.toString() };
}

export async function api(path, payload, image) {
  if (image) {
    const form = new FormData();
    form.set("message", JSON.stringify(payload));
    form.set("image", image);
    payload = form;
  }
  const headers = new Headers();
  if (path === "send") headers.set("Accept", SEND_CONFIRMATION);
  if (!image) headers.set("Content-Type", "application/json");
  const response = await fetch("/api/" + path, { method: "POST", headers, body: image ? payload : JSON.stringify(payload) });
  if (response.status === 401) window.dispatchEvent(new Event(AUTH_CHECK));
  if (response.ok && response.headers.get("content-type")?.split(";")[0] === SEND_CONFIRMATION) return readSendConfirmation(response);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}

/** After a deploy the server runs a newer build than this page; offer a reload until the operator takes it. */
export async function checkBuild() {
  try {
    const response = await fetch("/api/version", { cache: "no-store" });
    const { build } = await response.json();
    if (!build || build === BUILD) return toast.dismiss(UPDATE_TOAST);
    toast.info("Update available", {
      id: UPDATE_TOAST, duration: Infinity, description: "A new version of AI Collab is deployed.",
      action: { label: "Reload", onClick: () => window.location.reload() },
    });
  } catch {}
}

export async function signOut() {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  window.dispatchEvent(new Event(AUTH_CHECK));
}
