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
import { claudePermissionError } from "./harness.ts";
import { bypassRefusal } from "./sessions/launch.ts";

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

// A permission mode argument: one of the Claude values, refused when bypassPermissions has no OpenShell or host allowance.
function permissionArg(value, { sandboxed = false } = {}) {
  const mode = String(value ?? "").trim();
  if (!mode) return { error: "Give a permission mode, for example /permission default." };
  const error = claudePermissionError(mode);
  if (error) return { error };
  const refusal = bypassRefusal(mode, { sandboxed });
  return refusal ? { error: refusal } : { mode };
}

/** /permission <mode>: stores the mode for the session's next start or wake; the running turn keeps its mode. */
async function permissionCommand(peer, args, { setPermission }) {
  if (peer.harness !== "claude") return { status: "unsupported", detail: "/permission sets Claude's permission mode." };
  const checked = permissionArg(args, { sandboxed: peer.sandbox === true });
  if (checked.error) return { status: "failed", detail: checked.error };
  if (!setPermission) return { status: "unsupported", detail: "No store for the session's permission mode." };
  try {
    const where = await setPermission(peer, checked.mode);
    return { status: "succeeded", detail: `The next start or wake of this session uses ${checked.mode} (${where === "owned" ? "runner record" : "session registry"}).` };
  } catch (error) {
    return { status: "failed", detail: error.message };
  }
}

/** /team-permission <team> <mode>: validates both words, then asks the operator to confirm before the team.dot write. */
function teamPermissionCommand(args, { askTeamPermission }) {
  const [team, value, ...extra] = String(args ?? "").trim().split(/\s+/);
  if (!team || !value || extra.length) return { status: "failed", detail: "Use /team-permission <team> <mode>." };
  const checked = permissionArg(value);
  if (checked.error) return { status: "failed", detail: checked.error };
  if (!askTeamPermission) return { status: "unsupported", detail: "No team store for /team-permission." };
  return askTeamPermission(team, checked.mode);
}

/** Resolves {status, detail}; status is succeeded, failed, pending or unsupported. */
export async function slashCommand(peer, { name, args = "" }, { compact, opencode = opencodeRequest, setPermission, askTeamPermission } = {}) {
  if (!peer || !verifiedSession(peer)) return { status: "unsupported", detail: "Missing a verified native session ID or workspace." };
  if (name === "team-permission") return teamPermissionCommand(args, { askTeamPermission });
  const support = commandSupport(peer.harness, name);
  if (support.status === "unsupported") return { status: "unsupported", detail: support.reason };
  if (name === "permission") return permissionCommand(peer, args, { setPermission });
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
