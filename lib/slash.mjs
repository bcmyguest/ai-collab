/**
 * Runs a slash command the phone sent to a session. Support comes from web/lib/slash-commands.js; compact reuses the
 * caller's compaction control. OpenCode commands go to its service API; other harnesses report unsupported.
 * Every command passes the same session checks as compaction (lib/sessions/control.ts): a native session ID, an absolute
 * workspace, and a registry ID that matches the session label.
 */
import { isAbsolute } from "node:path";
import { sessionLabel } from "./config.mjs";
import { nativeSessionId } from "./sessions/control.ts";
import { opencodeRequest } from "./opencode-api.mjs";
import { commandSupport } from "../web/lib/slash-commands.js";

const NEEDS_MODEL = { status: "failed", detail: "Give a model as provider/model, for example /model anthropic/claude-sonnet." };
// Compact takes no instructions: no harness here has a verified channel for them.
const COMPACT_ARGS = {
  claude: "Claude's compaction through the Agent SDK takes no instructions here.",
  codex: "thread/compact/start takes only a thread id (app-server schema), so it takes no instructions.",
  opencode: "The session.compact request body is not verified, so it takes no instructions.",
};

/** The {providerID, modelID} pair from "provider/model", or null when either part is missing. */
export function modelRef(args) {
  const slash = args.indexOf("/");
  if (slash <= 0 || slash === args.length - 1) return null;
  return { providerID: args.slice(0, slash), modelID: args.slice(slash + 1) };
}

// The checks lib/sessions/control.ts makes before any compaction, applied to every command.
function verifiedSession(peer) {
  return nativeSessionId(peer.harness, peer.sessionId) && typeof peer.cwd === "string" && isAbsolute(peer.cwd) &&
    typeof peer.id === "string" && peer.id.endsWith("#" + sessionLabel(peer.sessionId));
}

/** Resolves {status, detail}; status is succeeded, failed or unsupported. */
export async function slashCommand(peer, { name, args = "" }, { compact, opencode = opencodeRequest } = {}) {
  if (!peer || !verifiedSession(peer)) return { status: "unsupported", detail: "Missing a verified native session ID or workspace." };
  const support = commandSupport(peer.harness, name);
  if (support.status === "unsupported") return { status: "unsupported", detail: support.reason };
  if (name === "compact") {
    if (args) return { status: "unsupported", detail: COMPACT_ARGS[peer.harness] };
    return compact(peer);
  }
  if (peer.harness !== "opencode") return { status: "unsupported", detail: support.reason };
  const path = `/api/session/${encodeURIComponent(peer.sessionId)}`;
  if (name === "model") {
    const ref = modelRef(args);
    if (!ref) return NEEDS_MODEL;
    const r = await opencode("POST", `${path}/model`, { body: ref });
    return r.ok ? { status: "succeeded", detail: `Switched the model to ${args}.` } : { status: "failed", detail: r.error };
  }
  const r = await opencode("POST", `${path}/command`, { body: { command: name, arguments: args } });
  return r.ok ? { status: "succeeded", detail: `Ran /${name}.` } : { status: "failed", detail: r.error };
}
