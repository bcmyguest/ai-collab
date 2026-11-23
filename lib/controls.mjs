import { spawn } from "node:child_process";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { sessionLabel } from "./config.mjs";
import { codexRequiredRunCodeArgs, REQUIRE_RUN_CODE_ENV } from "./code-mode.mjs";
import { isRunning } from "./process.mjs";
import { codexCompact, codexLiveCompact } from "./codex-compact.mjs";
import { sendMessage } from "./inbox.mjs";
import { WAKE_ENV, WAKE_PROMPT } from "./mode.mjs";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
// OpenCode session IDs are "ses_" and 26 base-62 characters (OpenCode 2.2.5 logs and API).
export const OPENCODE_SESSION_ID = /^ses_[A-Za-z0-9]{20,40}$/;
export const SANDBOX_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const pending = new Map();
// Asked of a running session that ai-collab cannot compact from outside; delivered urgent, at its next hook.
export const COMPACT_REQUEST = "[ai-collab] The operator asked to compact this session's context. Finish or checkpoint your current step, "
  + "reply to the operator in one line with what is still in progress, then end your turn so the operator can run /compact.";

/** Compact a saved Claude session through the Agent SDK; resolves with its compact_boundary metadata. */
async function sdkCompact(sessionId, cwd) {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  let boundary = null;
  let result = null;
  for await (const m of query({ prompt: "/compact", options: { cwd, resume: sessionId, settingSources: [], allowedTools: [] } })) {
    if (m.type === "system" && m.subtype === "compact_boundary") boundary = m.compact_metadata;
    if (m.type === "result") result = m.subtype;
  }
  return { boundary, result };
}

function invoke(file, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, stdio: "ignore", shell: false });
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
}

function harnessCommand(action, harness, id, requireRunCode) {
  if (action === "wake") {
    switch (harness) {
      case "claude": return ["claude", ["--print", "--resume", id, WAKE_PROMPT]];
      case "codex": return ["codex", ["exec", ...(requireRunCode ? codexRequiredRunCodeArgs() : []), "resume", id, WAKE_PROMPT]];
      case "cursor": return ["agent", ["--print", "--resume", id, WAKE_PROMPT]];
      case "opencode": return ["opencode", ["run", "--session", id, WAKE_PROMPT]];
    }
  }
  // OpenCode's server compacts a session through its API, running or not (operation session.compact).
  if (action === "compact" && harness === "opencode") return ["opencode", ["api", "session.compact", "--param", `sessionID=${id}`, "--data", "{}"]];
  return null;
}

/** Whether a session ID has the shape its harness uses. */
export function nativeSessionId(harness, id) {
  return typeof id === "string" && (harness === "opencode" ? OPENCODE_SESSION_ID : uuid).test(id);
}

/** The environment for a harness child: this process's without AI_COLLAB_*, with node's and ~/.local/bin on PATH. */
export function harnessEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AI_COLLAB_")));
  env.PATH = [dirname(process.execPath), join(homedir(), ".local", "bin"), env.PATH].filter(Boolean).join(delimiter);
  return env;
}

/** Runner from AI_COLLAB_WAKE_RUNNER (host | openshell) and AI_COLLAB_OPENSHELL_SANDBOX. */
export function runnerFromEnv(env = process.env) {
  const kind = env.AI_COLLAB_WAKE_RUNNER || "host";
  if (kind === "host") return { kind };
  if (kind === "openshell" && SANDBOX_NAME.test(env.AI_COLLAB_OPENSHELL_SANDBOX || "")) {
    return { kind, sandbox: env.AI_COLLAB_OPENSHELL_SANDBOX };
  }
  return { kind: "invalid" };
}

/** The argv as given on the host, or wrapped in `openshell sandbox exec` for the openshell runner. */
export function placeCommand([file, args], cwd, runner) {
  if (runner.kind !== "openshell") return [file, args];
  return ["openshell", ["sandbox", "exec", "--name", runner.sandbox, "--workdir", cwd, "--no-tty", "--no-login-shell", "--", file, ...args]];
}

/**
 * Compaction of a running session. Codex: compact over the local app-server daemon when the thread is loaded there and
 * idle. Otherwise (Claude, Cursor, a busy or unattached Codex thread) send the session an urgent operator message
 * asking it to finish its step, and tell the operator to run /compact; no harness documents an outside trigger.
 */
async function compactRunning(peer, { cfg, codexLive, runner, env }) {
  const { sessionId, cwd, harness } = peer;
  let note = "";
  if (harness === "codex") {
    try {
      const r = await codexLive(sessionId, { cwd, env, command: placeCommand(["codex", ["app-server", "proxy"]], cwd, runner) });
      if (r.status === "compacted") return { status: "succeeded", detail: "Codex compacted the running thread through its app-server daemon." };
      note = r.status === "busy" ? "Codex is mid-turn. " : "This Codex session is not attached to the app-server daemon. ";
    } catch {
      note = "The Codex app-server daemon did not compact the thread. ";
    }
  }
  if (!cfg?.enabled) return { status: "unsupported", detail: `${note}The session is running. Run /compact in it directly.` };
  const where = harness === "claude" ? " in its terminal or from Remote Control" : harness === "codex" ? " in it, or press Compact again once its turn ends" : " in it";
  try {
    await sendMessage({ ...cfg, peer: "operator", session: "" }, peer.id, COMPACT_REQUEST, { operatorThread: true, system: true, urgent: true });
  } catch {
    return { status: "failed", detail: `${note}The compaction request could not be sent. Run /compact${where}.` };
  }
  return { status: "requested", detail: `${note}Asked the session to finish its step at its next hook. Run /compact${where}.` };
}

async function run(action, peer, { execute = invoke, compact = sdkCompact, codex = codexCompact, codexLive = codexLiveCompact, runner = runnerFromEnv(), cfg } = {}) {
  const { sessionId, cwd, harness } = peer;
  if (!nativeSessionId(harness, sessionId) || typeof cwd !== "string" || !isAbsolute(cwd) ||
      !peer.id?.endsWith("#" + sessionLabel(sessionId))) {
    return { status: "unsupported", detail: "Missing a verified native session ID or workspace." };
  }
  const command = harnessCommand(action, harness, sessionId, peer.requireRunCode === true);
  const sdk = action === "compact" && harness === "claude";
  const appServer = action === "compact" && harness === "codex";
  const adapter = Boolean(command || sdk || appServer);
  const noAdapter = { status: "unsupported", detail: `No ${action} adapter for ${harness}.` };
  // A running Cursor session still gets the compaction request; an exited one has no adapter.
  if (!adapter && !(action === "compact" && ["claude", "codex", "cursor"].includes(harness))) return noAdapter;
  if (runner.kind === "invalid") return { status: "failed", detail: "AI_COLLAB_WAKE_RUNNER is misconfigured." };
  if (!Number.isInteger(peer.pid) || typeof peer.pidStart !== "string") {
    return { status: "unsupported", detail: "No recorded harness process, so exit cannot be verified. The message stays queued." };
  }
  const env = harnessEnv();
  // OpenCode compacts through its server whether or not a turn is running.
  const serverCompact = action === "compact" && harness === "opencode";
  if (!serverCompact && isRunning({ pid: peer.pid, start: peer.pidStart })) {
    return action === "wake"
      ? { status: "queued", detail: "The session is running. Its next hook delivers the message." }
      : compactRunning(peer, { cfg, codexLive, runner, env });
  }
  if (!adapter) return noAdapter;
  if (sdk) {
    try {
      const { boundary, result } = await compact(sessionId, cwd);
      if (!boundary) return { status: "failed", detail: `Claude finished (${result ?? "no result"}) without compacting.` };
      return { status: "succeeded", detail: `Compacted ${boundary.pre_tokens} → ${boundary.post_tokens} tokens.` };
    } catch {
      return { status: "failed", detail: "Claude Agent SDK compaction failed." };
    }
  }
  if (appServer) {
    try {
      await codex(sessionId, { cwd, env, command: placeCommand(["codex", ["app-server"]], cwd, runner) });
      return { status: "succeeded", detail: "Codex compacted the thread." };
    } catch {
      return { status: "failed", detail: "Codex app-server compaction failed." };
    }
  }
  const [file, args] = placeCommand(command, cwd, runner);
  if (action === "wake" && peer.requireRunCode === true) env[REQUIRE_RUN_CODE_ENV] = "1";
  env[WAKE_ENV] = "1"; // hooks in the resumed run must not read its prompt as the operator returning
  try {
    const code = await execute(file, args, { cwd, env });
    if (code !== 0) return { status: "failed", detail: file + " exited " + (code ?? "after a signal") + "." };
    return { status: "succeeded", detail: serverCompact ? "OpenCode compacted the session." : "The harness finished the resumed turn." };
  } catch (error) {
    return { status: "failed", detail: error.code === "ENOENT" ? "Executable or workspace unavailable." : "Harness invocation failed." };
  }
}

/** One control run per session at a time; concurrent retries share the in-flight result. */
export function controlSession(action, peer, options) {
  if (!peer) return Promise.resolve({ status: "unsupported", detail: "Missing local session registration." });
  const key = JSON.stringify([peer.harness, peer.sessionId]);
  const active = pending.get(key);
  if (active?.action === action) return active.promise;
  if (active) return Promise.resolve({ status: "failed", detail: `A ${active.action} run for this session is in progress. Retry after it finishes.` });
  const promise = run(action, peer, options).finally(() => pending.delete(key));
  pending.set(key, { action, promise });
  return promise;
}
