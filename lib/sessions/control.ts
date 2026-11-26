// Control runs and interrupts on a session: wake, compact, interrupt, and the environment a harness child gets.
import { spawn, type SpawnOptions } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { sessionLabel } from "../config.mjs";
import { REQUIRE_RUN_CODE_ENV } from "../code-mode.mjs";
import { codexCompact, codexLiveCompact, CLIENT, connect } from "../codex-compact.mjs";
import { sendMessage } from "../inbox.mjs";
import { isRunning } from "../process.mjs";
import { WAKE_ENV, WAKE_PROMPT } from "../mode.mjs";
import { opencodeRequest } from "../opencode-api.mjs";
import { argv, type Command, type Harness } from "../harness.ts";
import type { Session, SessionCfg } from "./registry.ts";

type Outcome = { status: string; detail: string };
type CodexRpcOptions = { cwd?: string; env?: NodeJS.ProcessEnv; command?: Command };
type CodexLive = (threadId: string, options: CodexRpcOptions) => Promise<{ status: string }>;
type CodexCall = (threadId: string, options: CodexRpcOptions) => Promise<unknown>;

const NATIVE_UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
// OpenCode session IDs are "ses_" and 26 base-62 characters (OpenCode 2.2.5 logs and API).
const OPENCODE_SESSION_ID = /^ses_[A-Za-z0-9]{20,40}$/;
export const SANDBOX_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const pending = new Map<string, { action: string; promise: Promise<Outcome> }>();
// Asked of a running session that ai-collab cannot compact from outside; delivered urgent, at its next hook.
export const COMPACT_REQUEST = "[ai-collab] The operator asked to compact this session's context. Finish or checkpoint your current step, "
  + "reply to the operator in one line with what is still in progress, then end your turn so the operator can run /compact.";

/** The binary and argv that act on a session; the Cursor name is cursorBinary on the PATH the wake runs with. */
export function harnessCommand(action: string, harness: string, id: string, requireRunCode: boolean, { path = "" }: { path?: string } = {}): Command | null {
  if (action === "wake") return argv(harness as Harness, "wake", { id, prompt: WAKE_PROMPT, requireRunCode, path });
  if (action === "compact") return argv(harness as Harness, "compact", { id });
  return null;
}

/** Whether a session ID has the shape its harness uses. */
export function nativeSessionId(harness: string, id: unknown): boolean {
  return typeof id === "string" && (harness === "opencode" ? OPENCODE_SESSION_ID : NATIVE_UUID).test(id);
}

/** The environment for a harness child: this process's without AI_COLLAB_*, with node's and ~/.local/bin on PATH. */
export function harnessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AI_COLLAB_")));
  env.PATH = [dirname(process.execPath), join(homedir(), ".local", "bin"), env.PATH].filter(Boolean).join(delimiter);
  return env;
}

/** Runner from AI_COLLAB_WAKE_RUNNER (host | openshell) and AI_COLLAB_OPENSHELL_SANDBOX. */
export function runnerFromEnv(env: NodeJS.ProcessEnv = process.env): { kind: string; sandbox?: string } {
  const kind = env.AI_COLLAB_WAKE_RUNNER || "host";
  if (kind === "host") return { kind };
  if (kind === "openshell" && SANDBOX_NAME.test(env.AI_COLLAB_OPENSHELL_SANDBOX || "")) {
    return { kind, sandbox: env.AI_COLLAB_OPENSHELL_SANDBOX };
  }
  return { kind: "invalid" };
}

/** The argv as given on the host, or wrapped in `openshell sandbox exec` for the openshell runner. */
export function placeCommand([file, args]: Command, cwd: string, runner: { kind: string; sandbox?: string }): Command {
  if (runner.kind !== "openshell") return [file, args];
  return ["openshell", ["sandbox", "exec", "--name", runner.sandbox as string, "--workdir", cwd, "--no-tty", "--no-login-shell", "--", file, ...args]];
}

function invoke(file: string, args: string[], options: SpawnOptions): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, stdio: "ignore", shell: false });
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
}

/** Compact a saved Claude session through the Agent SDK; resolves with its compact_boundary metadata. */
async function sdkCompact(sessionId: string, cwd: string): Promise<{ boundary: { pre_tokens: number; post_tokens: number } | null; result: string | null }> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  let boundary: { pre_tokens: number; post_tokens: number } | null = null;
  let result: string | null = null;
  for await (const m of query({ prompt: "/compact", options: { cwd, resume: sessionId, settingSources: [], allowedTools: [] } })) {
    if (m.type === "system" && m.subtype === "compact_boundary") boundary = m.compact_metadata as { pre_tokens: number; post_tokens: number };
    if (m.type === "result") result = m.subtype;
  }
  return { boundary, result };
}

/** Compacts a running session: Codex through its daemon when idle, else an urgent request to finish the step. */
async function compactRunning(peer: Session, { cfg, codexLive, runner, env }: {
  cfg?: SessionCfg; codexLive: CodexLive; runner: { kind: string; sandbox?: string }; env: NodeJS.ProcessEnv;
}): Promise<Outcome> {
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
    await sendMessage({ ...cfg, peer: "operator", session: "" } as never, peer.id as string, COMPACT_REQUEST, { operatorThread: true, system: true, urgent: true } as never);
  } catch {
    return { status: "failed", detail: `${note}The compaction request could not be sent. Run /compact${where}.` };
  }
  return { status: "requested", detail: `${note}Asked the session to finish its step at its next hook. Run /compact${where}.` };
}

async function run(action: string, peer: Session, { execute = invoke, compact = sdkCompact, codex = codexCompact, codexLive = codexLiveCompact, runner = runnerFromEnv(), cfg }: {
  execute?: (file: string, args: string[], options: SpawnOptions) => Promise<number | null>;
  compact?: typeof sdkCompact;
  codex?: CodexCall;
  codexLive?: CodexLive;
  runner?: { kind: string; sandbox?: string };
  cfg?: SessionCfg;
} = {}): Promise<Outcome> {
  const { sessionId, cwd, harness } = peer;
  if (!nativeSessionId(harness, sessionId) || typeof cwd !== "string" || !isAbsolute(cwd) ||
      !peer.id?.endsWith("#" + sessionLabel(sessionId))) {
    return { status: "unsupported", detail: "Missing a verified native session ID or workspace." };
  }
  const env = harnessEnv();
  const command = harnessCommand(action, harness, sessionId, peer.requireRunCode === true, { path: env.PATH });
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
  // OpenCode compacts through its server whether or not a turn is running.
  const serverCompact = action === "compact" && harness === "opencode";
  if (!serverCompact && isRunning({ pid: peer.pid as number, start: peer.pidStart })) {
    return action === "wake"
      ? { status: "queued", detail: "The session is running. Its next hook delivers the message." }
      : compactRunning(peer, { cfg, codexLive, runner, env });
  }
  if (!adapter) return noAdapter;
  if (sdk) {
    try {
      const { boundary, result } = await compact(sessionId as string, cwd);
      if (!boundary) return { status: "failed", detail: `Claude finished (${result ?? "no result"}) without compacting.` };
      return { status: "succeeded", detail: `Compacted ${boundary.pre_tokens} → ${boundary.post_tokens} tokens.` };
    } catch {
      return { status: "failed", detail: "Claude Agent SDK compaction failed." };
    }
  }
  if (appServer) {
    try {
      await codex(sessionId as string, { cwd, env, command: placeCommand(["codex", ["app-server"]], cwd, runner) });
      return { status: "succeeded", detail: "Codex compacted the thread." };
    } catch {
      return { status: "failed", detail: "Codex app-server compaction failed." };
    }
  }
  const [file, args] = placeCommand(command as Command, cwd, runner);
  if (action === "wake" && peer.requireRunCode === true) env[REQUIRE_RUN_CODE_ENV] = "1";
  env[WAKE_ENV] = "1"; // hooks in the resumed run must not read its prompt as the operator returning
  try {
    const code = await execute(file, args, { cwd, env });
    if (code !== 0) return { status: "failed", detail: file + " exited " + (code ?? "after a signal") + "." };
    return { status: "succeeded", detail: serverCompact ? "OpenCode compacted the session." : "The harness finished the resumed turn." };
  } catch (error) {
    return { status: "failed", detail: (error as NodeJS.ErrnoException).code === "ENOENT" ? "Executable or workspace unavailable." : "Harness invocation failed." };
  }
}

/** One control run per session at a time; concurrent retries share the in-flight result. */
export function controlSession(action: string, peer: Session | undefined, options?: Parameters<typeof run>[2]): Promise<Outcome> {
  if (!peer) return Promise.resolve({ status: "unsupported", detail: "Missing local session registration." });
  const key = JSON.stringify([peer.harness, peer.sessionId]);
  const active = pending.get(key);
  if (active?.action === action) return active.promise;
  if (active) return Promise.resolve({ status: "failed", detail: `A ${active.action} run for this session is in progress. Retry after it finishes.` });
  const promise = run(action, peer, options).finally(() => pending.delete(key));
  pending.set(key, { action, promise });
  return promise;
}

/** Interrupts a thread's turn in the app-server daemon; resolves interrupted, not-running or not-loaded. */
export async function codexLiveInterrupt(threadId: string, { cwd, env, command = argv("codex", "interrupt", {}) as Command, timeoutMs = 15_000 }: {
  cwd?: string; env?: NodeJS.ProcessEnv; command?: Command; timeoutMs?: number;
} = {}): Promise<{ status: string }> {
  const rpc = connect(command, { cwd, env });
  const timer = setTimeout(() => rpc.close(), timeoutMs);
  try {
    await rpc.request("initialize", { clientInfo: CLIENT, capabilities: null });
    rpc.send({ method: "initialized" });
    const loaded: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await rpc.request("thread/loaded/list", cursor ? { cursor } : {}) as { data?: string[]; nextCursor?: unknown };
      loaded.push(...(Array.isArray(page?.data) ? page.data : []));
      cursor = typeof page?.nextCursor === "string" ? page.nextCursor : null;
    } while (cursor && !loaded.includes(threadId));
    if (!loaded.includes(threadId)) return { status: "not-loaded" };
    const read = await rpc.request("thread/read", { threadId, includeTurns: true }) as { thread?: { turns?: { id?: string; status?: string }[] } };
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
export async function interruptSession(peer: Session | null | undefined, { env = harnessEnv(), runner = runnerFromEnv(), codexInterrupt = codexLiveInterrupt, opencode = opencodeRequest }: {
  env?: NodeJS.ProcessEnv;
  runner?: { kind: string; sandbox?: string };
  codexInterrupt?: typeof codexLiveInterrupt;
  opencode?: typeof opencodeRequest;
} = {}): Promise<Outcome> {
  if (!peer) return { status: "unsupported", detail: "Missing local session registration." };
  const { sessionId, cwd, harness } = peer;
  if (!["codex", "opencode"].includes(harness)) {
    return { status: "unsupported", detail: `${harness} has no outside interrupt; press Esc in its terminal.` };
  }
  if (!nativeSessionId(harness, sessionId) || !peer.id?.endsWith("#" + sessionLabel(sessionId))) {
    return { status: "unsupported", detail: "Missing a verified native session ID." };
  }
  if (harness === "opencode") {
    const r = await opencode("POST", `/api/session/${encodeURIComponent(sessionId as string)}/interrupt`);
    if (!r.ok) return r.status === 404 ? { status: "not-running", detail: "OpenCode has no such running session." } : { status: "failed", detail: r.error as string };
    const interrupted = r.body?.interrupted ?? r.body?.data?.interrupted;
    return interrupted ? { status: "succeeded", detail: "OpenCode interrupted the turn." } : { status: "not-running", detail: "No turn was running." };
  }
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return { status: "unsupported", detail: "Missing a workspace." };
  if (runner.kind === "invalid") return { status: "failed", detail: "AI_COLLAB_WAKE_RUNNER is misconfigured." };
  try {
    const r = await codexInterrupt(sessionId as string, { cwd, env, command: placeCommand(argv("codex", "interrupt", {}) as Command, cwd, runner) });
    if (r.status === "interrupted") return { status: "succeeded", detail: "Codex interrupted the turn." };
    if (r.status === "not-running") return { status: "not-running", detail: "No turn was running." };
    return { status: "unsupported", detail: "This Codex session is not attached to the app-server daemon." };
  } catch {
    return { status: "failed", detail: "The Codex app-server daemon did not interrupt the turn." };
  }
}

