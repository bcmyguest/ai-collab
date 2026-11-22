/**
 * Runs a slash command the phone sent to a session. Support comes from web/lib/slash-commands.js; compact reuses the
 * caller's compaction control. OpenCode commands go to its service API; other harnesses report unsupported.
 */
import { commandSupport } from "../web/lib/slash-commands.js";
import { opencodeRequest } from "./opencode-api.mjs";

const NEEDS_MODEL = { status: "failed", detail: "Give a model as provider/model, for example /model anthropic/claude-sonnet." };

/** The {providerID, modelID} pair from "provider/model", or null when either part is missing. */
export function modelRef(args) {
  const slash = args.indexOf("/");
  if (slash <= 0 || slash === args.length - 1) return null;
  return { providerID: args.slice(0, slash), modelID: args.slice(slash + 1) };
}

/** Resolves {status, detail}; status is succeeded, failed or unsupported. */
export async function slashCommand(peer, { name, args = "" }, { compact, opencode = opencodeRequest } = {}) {
  if (!peer) return { status: "unsupported", detail: "Missing local session registration." };
  const support = commandSupport(peer.harness, name);
  if (support.status === "unsupported") return { status: "unsupported", detail: support.reason };
  if (name === "compact") return compact(peer);
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
