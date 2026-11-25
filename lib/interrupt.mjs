/**
 * Interrupt a running turn. OpenCode: POST /api/session/<id>/interrupt on its service. Codex: `turn/interrupt` over the
 * local app-server daemon (`codex app-server proxy`); `codex queue` has no interrupt. Claude and Cursor have no outside
 * interrupt, so they report unsupported.
 */
import { isAbsolute } from "node:path";
import { sessionLabel } from "./config.mjs";
import { CLIENT, connect } from "./codex-compact.mjs";
import { harnessEnv, nativeSessionId, placeCommand, runnerFromEnv } from "./controls.mjs";
import { opencodeRequest } from "./opencode-api.mjs";
import { argv } from "./harness.ts";

const TIMEOUT_MS = 15_000;

/**
 * Interrupts the in-progress turn of a thread loaded in the app-server daemon.
 * Resolves {status:"interrupted"}, {status:"not-running"} (no turn in progress) or {status:"not-loaded"}.
 */
export async function codexLiveInterrupt(threadId, { cwd, env, command = argv("codex", "interrupt", {}), timeoutMs = TIMEOUT_MS } = {}) {
  const rpc = connect(command, { cwd, env });
  const timer = setTimeout(() => rpc.close(), timeoutMs);
  try {
    await rpc.request("initialize", { clientInfo: CLIENT, capabilities: null });
    rpc.send({ method: "initialized" });
    const loaded = [];
    let cursor = null;
    do {
      const page = await rpc.request("thread/loaded/list", cursor ? { cursor } : {});
      loaded.push(...(Array.isArray(page?.data) ? page.data : []));
      cursor = typeof page?.nextCursor === "string" ? page.nextCursor : null;
    } while (cursor && !loaded.includes(threadId));
    if (!loaded.includes(threadId)) return { status: "not-loaded" };
    const read = await rpc.request("thread/read", { threadId, includeTurns: true });
    const turn = (read?.thread?.turns ?? []).findLast((t) => t?.status === "inProgress");
    if (!turn?.id) return { status: "not-running" };
    await rpc.request("turn/interrupt", { threadId, turnId: turn.id });
    return { status: "interrupted" };
  } finally {
    clearTimeout(timer);
    rpc.close();
  }
}

/** Interrupts a registry session's running turn; resolves {status: succeeded|not-running|unsupported|failed, detail}. */
export async function interruptSession(peer, { env = harnessEnv(), runner = runnerFromEnv(), codexInterrupt = codexLiveInterrupt, opencode = opencodeRequest } = {}) {
  if (!peer) return { status: "unsupported", detail: "Missing local session registration." };
  const { sessionId, cwd, harness } = peer;
  if (!["codex", "opencode"].includes(harness)) {
    return { status: "unsupported", detail: `${harness} has no outside interrupt; press Esc in its terminal.` };
  }
  if (!nativeSessionId(harness, sessionId) || !peer.id?.endsWith("#" + sessionLabel(sessionId))) {
    return { status: "unsupported", detail: "Missing a verified native session ID." };
  }
  if (harness === "opencode") {
    const r = await opencode("POST", `/api/session/${encodeURIComponent(sessionId)}/interrupt`);
    if (!r.ok) return r.status === 404 ? { status: "not-running", detail: "OpenCode has no such running session." } : { status: "failed", detail: r.error };
    const interrupted = r.body?.interrupted ?? r.body?.data?.interrupted;
    return interrupted ? { status: "succeeded", detail: "OpenCode interrupted the turn." } : { status: "not-running", detail: "No turn was running." };
  }
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return { status: "unsupported", detail: "Missing a workspace." };
  if (runner.kind === "invalid") return { status: "failed", detail: "AI_COLLAB_WAKE_RUNNER is misconfigured." };
  try {
    const r = await codexInterrupt(sessionId, { cwd, env, command: placeCommand(argv("codex", "interrupt", {}), cwd, runner) });
    if (r.status === "interrupted") return { status: "succeeded", detail: "Codex interrupted the turn." };
    if (r.status === "not-running") return { status: "not-running", detail: "No turn was running." };
    return { status: "unsupported", detail: "This Codex session is not attached to the app-server daemon." };
  } catch {
    return { status: "failed", detail: "The Codex app-server daemon did not interrupt the turn." };
  }
}
