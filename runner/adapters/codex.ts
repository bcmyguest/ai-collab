// Owned-session adapter for Codex: one `codex app-server` child per runner, frames routed by threadId.
// Method and field names: `codex app-server generate-json-schema` at codex-cli 0.171.0 (see docs/owned-sessions-contract.md).
import { spawn, execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { EventType } from "@ag-ui/core";
import { sessionLabel } from "../../lib/config.ts";
import { CLIENT } from "../../lib/codex-compact.ts";
import { codexThreadConfig } from "../../lib/code-mode.ts";
import { CODEX_NO_SUBAGENT_ARGS } from "../../lib/subagent-guard.ts";
import { codexSandboxEnv, createCodexSandbox } from "./cli-sandbox.ts";
import type { CliBox, CliSandbox } from "./cli-sandbox.ts";
import { APPROVAL_REQUESTED, APPROVAL_RESOLVED, ERROR, NOTICE, PERMISSION_MODES, permissionSettings } from "../contract.ts";

import type { Decision, SessionContext, UserInput } from "../types.d.ts";

// oxlint-disable-next-line typescript/no-explicit-any -- harness protocol frames, session records and runner requests are JSON
type Json = any;

export const APP_SERVER_ARGS = ["app-server", "-c", "thread_unload_delay_secs=0"];
const DEFAULT_COMMAND = { file: "codex", args: APP_SERVER_ARGS, version: ["--version"] };
const REQUEST_MS = 60_000;
const COMPACT_MS = 5 * 60_000;
const METHOD_NOT_FOUND = -32601;
const SANDBOX_MODE = { readOnly: "read-only", workspaceWrite: "workspace-write", dangerFullAccess: "danger-full-access" };
const APPROVAL_TOOL = {
  "item/commandExecution/requestApproval": "Bash",
  "item/fileChange/requestApproval": "Edit",
  "item/permissions/requestApproval": "Permissions",
};
const FAILED_STATUS = ["failed", "declined"];

/** Thread-level settings for a mode: approval policy, reviewer and the sandbox mode name `thread/start` takes. */
const threadPolicy = (settings: Json) => ({
  approvalPolicy: settings.approvalPolicy,
  approvalsReviewer: settings.approvalsReviewer,
  sandbox: SANDBOX_MODE[settings.sandboxPolicy.type as keyof typeof SANDBOX_MODE],
});

/** Inside OpenShell the sandbox is the boundary: Codex runs with no approvals and full access to the sandbox. */
export const openshellPermission = (settings: Json) => ({ ...settings, approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });

/** Turn-level settings for a mode: the same policy with the sandbox as an object, as `turn/start` takes it. */
const turnPolicy = (settings: Json) => ({
  approvalPolicy: settings.approvalPolicy,
  approvalsReviewer: settings.approvalsReviewer,
  sandboxPolicy: settings.sandboxPolicy,
});

/** The thread `config` override for a session's code-mode setting; none when the setting is unknown (older records). */
const threadConfig = (codeMode: Json) => (typeof codeMode === "boolean" ? { config: codexThreadConfig(codeMode) } : {});

const userInput = (input: UserInput) => [{ type: "text", text: input.text, text_elements: [] }];
const text = (value: Json) => (typeof value === "string" ? value : "");

function startServer(pool: Json, env: Json) {
  const { file, args } = pool.command;
  const child = spawn(file, args, { env: { ...env, AI_COLLAB_OWNED: "codex" }, stdio: ["pipe", "pipe", "ignore"], shell: false });
  child.stdin.on("error", () => {});
  const server: Json = { child, pool, nextId: 0, pending: new Map(), sessions: new Map(), exited: false };
  server.write = (message: Json) => child.stdin.write(`${JSON.stringify(message)}\n`);
  server.request = (method: Json, params: Json) => new Promise((resolve, reject) => {
    const id = ++server.nextId;
    const timer = setTimeout(() => {
      server.pending.delete(id);
      const error: Error & { timedOut?: boolean } = new Error(`codex ${method} timed out`);
      error.timedOut = true;
      reject(error);
    }, pool.requestMs);
    server.pending.set(id, {
      resolve: (value: Json) => { clearTimeout(timer); resolve(value); },
      reject: (error: Json) => { clearTimeout(timer); reject(error); },
    });
    server.write({ id, method, params });
  });
  server.reply = (id: Json, result: Json) => server.write({ id, result });
  server.fail = (id: Json, message: Json) => server.write({ id, error: { code: METHOD_NOT_FOUND, message } });
  createInterface({ input: child.stdout }).on("line", (line) => route(server, line));
  child.once("error", () => onExit(server));
  child.once("close", () => onExit(server));
  return server;
}

/** Starts the shared child and runs `initialize`; one child serves every thread of the runner. */
async function connectServer(pool: Json, env: Json) {
  const server = startServer(pool, env);
  pool.booting = server; // shutdown kills a child that has not finished its handshake
  try {
    await server.request("initialize", { clientInfo: CLIENT, capabilities: { experimentalApi: true } });
  } catch (error: Json) {
    server.child.kill();
    throw error;
  } finally {
    if (pool.booting === server) pool.booting = null;
  }
  server.write({ method: "initialized" });
  return server;
}

function currentServer(pool: Json, env: Json) {
  if (pool.server && !pool.server.exited) return pool.server;
  pool.starting ??= connectServer(pool, env)
    .then((server) => { pool.server = server; return server; })
    .finally(() => { pool.starting = null; });
  return pool.starting;
}

function route(server: Json, line: Json) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method !== undefined && message.id !== undefined) return onServerRequest(server, message);
  if (message.method !== undefined) return onNotification(server, message);
  const waiter = server.pending.get(message.id);
  if (!waiter) return;
  server.pending.delete(message.id);
  if (message.error) {
    // An error response means the server refused the request and ran nothing, so the caller may retry it safely.
    // The case that matters: a wake right after a session ended can reach a thread that is still closing.
    const error = Object.assign(new Error(message.error.message || "codex app-server error"), { retryable: true });
    waiter.reject(error);
  }
  else waiter.resolve(message.result);
}

function onExit(server: Json) {
  if (server.exited) return;
  server.exited = true;
  if (server.pool.server === server) server.pool.server = null;
  for (const waiter of server.pending.values()) waiter.reject(new Error("codex app-server exited"));
  server.pending.clear();
  for (const session of server.sessions.values()) {
    settleCompact(session, new Error("codex app-server exited during compaction"));
    if (session.turnId) session.ctx.emit({ type: EventType.RUN_ERROR, message: "codex app-server exited during the run", metadata: { aiCollab: { runId: session.turnId } } });
    for (const interruptId of session.approvals.keys()) session.ctx.emit({ type: EventType.CUSTOM, name: APPROVAL_RESOLVED, value: { interruptId, status: "cancelled", reason: "cancelled" } });
    session.approvals.clear();
    session.codeCalls.clear();
    session.turnId = null;
    session.server = null;
  }
  server.sessions.clear();
}

// Settles the session's in-flight compact(): resolves with its token counts, or rejects with the reason.
function settleCompact(session: Json, error?: Json) {
  const wait = session.compactWait;
  if (!wait) return;
  session.compactWait = null;
  if (error !== undefined) wait.reject(error instanceof Error ? error : new Error(String(error)));
  else wait.resolve({ ...(wait.before !== null ? { before: wait.before } : {}), ...(wait.after !== null ? { after: wait.after } : {}) });
}

// A compaction turn's first token count is its before, the last its after.
function compactTokens(session: Json, usage: Json) {
  const tokens = usage?.last?.totalTokens;
  if (!Number.isSafeInteger(tokens)) return;
  if (session.compactWait.before === null) session.compactWait.before = tokens;
  else session.compactWait.after = tokens;
}

function onNotification(server: Json, { method, params }: Json) {
  const session = server.sessions.get(params?.threadId);
  if (!session) return;
  // A compaction turn: its own turn lifecycle, not a prompt run, so it never opens a RUN.
  if (session.compactWait) {
    if (method === "turn/started") {
      if (!session.compactWait.turnId) session.compactWait.turnId = params.turn?.id;
      return;
    }
    if (method === "turn/completed") return settleCompact(session);
    if (method === "error") return settleCompact(session, params.error?.message);
    if (method === "thread/tokenUsage/updated") compactTokens(session, params.tokenUsage);
  }
  switch (method) {
    case "turn/started": return turnStarted(session, params.turn);
    case "turn/completed": return void completeTurn(session, params.turn);
    case "item/completed": return itemCompleted(session, params.item);
    case "rawResponseItem/completed":
      if (params.turnId === session.turnId) return codeItem(session, params.item);
      return;
    case "thread/tokenUsage/updated": return tokenUsage(session, params.tokenUsage);
    case "serverRequest/resolved": return requestResolved(session, params.requestId);
    case "error": return codexError(session, params);
  }
}

function turnStarted(session: Json, turn: Json) {
  session.turnId = turn.id;
  const { emit } = session.ctx;
  emit({
    type: EventType.RUN_STARTED, threadId: session.address, runId: turn.id,
    input: { threadId: session.address, runId: turn.id, tools: [], context: [], messages: [{ id: `${turn.id}:input`, role: "user", content: session.prompt }] },
  });
}

async function completeTurn(session: Json, turn: Json) {
  const server = session.server;
  // Codex 0.171 only exposes experimentalRawEvents on thread/start. After
  // resume, read the portion of the native rollout appended during this turn.
  if (session.rolloutOffset !== null) {
    const start = session.rolloutOffset;
    session.rolloutOffset = null;
    try {
      const { size } = await stat(session.rolloutPath);
      if (size > start) {
        const input = createReadStream(session.rolloutPath, { start, end: size - 1 });
        const lines = createInterface({ input, crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            if (session.server !== server) break;
            let row;
            try { row = JSON.parse(line); } catch { continue; }
            if (row.type === "response_item") codeItem(session, row.payload);
          }
        } finally {
          input.destroy();
        }
      }
    } catch (error: Json) {
      session.ctx.log(`could not read Codex code calls: ${error.message}`);
    }
  }
  if (server && session.server === server) turnCompleted(session, turn);
}

function turnCompleted(session: Json, turn: Json) {
  if (turn.status !== "completed" && turn.status !== "interrupted" && turn.status !== "failed") return;
  session.turnId = null;
  session.codeCalls.clear();
  if (turn.status === "failed") {
    // codexErrorInfo is UNVERIFIED: the field name is not in the repo's schema snapshot; lib/limits.ts reads it for plan limits.
    session.ctx.emit({ type: EventType.RUN_ERROR, message: turn.error?.message || "turn failed", metadata: { aiCollab: { runId: turn.id, codexErrorInfo: turn.error?.codexErrorInfo } } });
    return;
  }
  const type = turn.status === "interrupted" ? "cancelled" : "success";
  session.ctx.emit({ type: EventType.RUN_FINISHED, threadId: session.address, runId: turn.id, outcome: { type } });
}

function itemCompleted(session: Json, item: Json) {
  const { emit } = session.ctx;
  switch (item.type) {
    case "agentMessage":
      return emit({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: item.id, role: "assistant", delta: text(item.text) });
    case "commandExecution":
      return toolCall(session, item.id, "Bash", { command: item.command }, text(item.aggregatedOutput), FAILED_STATUS.includes(item.status));
    case "fileChange":
      return toolCall(session, item.id, "Edit", { changes: item.changes }, "", FAILED_STATUS.includes(item.status));
    case "mcpToolCall":
      return toolCall(session, item.id, item.tool, item.arguments, "", FAILED_STATUS.includes(item.status));
    case "contextCompaction":
      emit({ type: EventType.STEP_STARTED, stepName: "compact", metadata: { aiCollab: { compaction: { phase: "started" } } } });
      return emit({ type: EventType.STEP_FINISHED, stepName: "compact", metadata: { aiCollab: { compaction: { phase: "finished" } } } });
  }
}

function codeItem(session: Json, item: Json) {
  const id = item?.call_id;
  if (!session.turnId || typeof id !== "string") return;
  if (item.type === "custom_tool_call" && item.name === "exec" && typeof item.input === "string") {
    if (session.codeCalls.has(id)) return;
    session.codeCalls.set(id, false);
    session.ctx.emit({ type: EventType.TOOL_CALL_CHUNK, toolCallId: id, toolCallName: "exec", delta: item.input });
  } else if (item.type === "custom_tool_call_output" && session.codeCalls.get(id) === false) {
    session.codeCalls.set(id, true);
    const content = Array.isArray(item.output) ? item.output.map((block: Json) => text(block.text)).join("") : text(item.output);
    session.ctx.emit({ type: EventType.TOOL_CALL_RESULT, toolCallId: id, messageId: `${id}:result`, role: "tool", content,
      metadata: { aiCollab: { toolCallName: "exec" } } });
  }
}

function toolCall(session: Json, id: Json, name: Json, input: Json, output: Json, failed: Json) {
  const { emit } = session.ctx;
  emit({ type: EventType.TOOL_CALL_CHUNK, toolCallId: id, toolCallName: name, delta: JSON.stringify(input ?? {}) });
  emit({
    type: EventType.TOOL_CALL_RESULT, toolCallId: id, messageId: `${id}:result`, role: "tool", content: output,
    metadata: { aiCollab: { toolCallName: name, failed } },
  });
}

function tokenUsage(session: Json, usage: Json) {
  const tokens = usage?.last?.totalTokens;
  if (!Number.isSafeInteger(tokens)) return;
  const window = Number.isSafeInteger(usage.modelContextWindow) ? usage.modelContextWindow : undefined;
  session.usage = { tokens, ...(window ? { window } : {}) };
  const delta = [{ op: "replace", path: "/contextTokens", value: tokens }];
  if (window) delta.push({ op: "replace", path: "/contextWindow", value: window });
  session.ctx.emit({ type: EventType.STATE_DELTA, delta });
}

function requestResolved(session: Json, requestId: Json) {
  for (const [interruptId, approval] of session.approvals) {
    if (approval.rpcId !== requestId) continue;
    session.approvals.delete(interruptId);
    session.ctx.emit({ type: EventType.CUSTOM, name: APPROVAL_RESOLVED, value: { interruptId, status: "cancelled", reason: "cancelled" } });
  }
}

function codexError(session: Json, { error, willRetry }: Json) {
  if (willRetry) return;
  session.ctx.emit({ type: EventType.CUSTOM, name: ERROR, value: text(error?.message) || "codex error" });
}

function onServerRequest(server: Json, message: Json) {
  const session = server.sessions.get(message.params?.threadId);
  const tool = APPROVAL_TOOL[message.method as keyof typeof APPROVAL_TOOL];
  if (!session || !tool) {
    // Requests the runner does not answer yet (user input, MCP elicitation, dynamic tools, auth refresh) get an error, never silence.
    server.fail(message.id, `ai-collab does not answer ${message.method} yet`);
    session?.ctx.emit({ type: EventType.CUSTOM, name: NOTICE, value: `codex asked for ${message.method}; the runner does not answer it yet` });
    return;
  }
  const params = message.params;
  const interruptId = String(message.id);
  session.approvals.set(interruptId, { rpcId: message.id, kind: message.method, permissions: params.permissions });
  session.ctx.emit({
    type: EventType.CUSTOM, name: APPROVAL_REQUESTED,
    value: { interruptId, reason: "tool_approval", toolCallId: params.itemId, toolCallName: tool, summary: text(params.command) || text(params.reason) },
  });
}

function makeHandle(session: Json) {
  return {
    nativeId: session.nativeId,
    async send(input: UserInput) {
      if (session.turnId) throw new Error("the codex turn is still running");
      if (session.compactWait) throw new Error("a codex compaction is still running");
      await attach(session);
      session.prompt = input.text;
      if (session.rolloutPath) {
        session.rolloutOffset = await stat(session.rolloutPath).then(({ size }) => size, () => null);
      }
      // A timed-out turn/start may still have started: the error says so, and the caller never resends.
      // An error response means the server refused the turn, so a retry cannot run it twice (see route()).
      const { turn } = await session.server.request("turn/start", {
        threadId: session.nativeId, input: userInput(input), cwd: session.cwd, ...turnPolicy(session.settings),
        ...(session.model ? { model: session.model } : {}),
      }).catch((error: Json) => {
        if (error.timedOut) error.mayHaveStarted = true;
        throw error;
      });
      return { runId: turn.id };
    },
    async steer(input: UserInput) {
      if (!session.turnId) throw new Error("no codex turn is running to steer");
      await liveServer(session).request("turn/steer", { threadId: session.nativeId, expectedTurnId: session.turnId, input: userInput(input) });
    },
    async interrupt() {
      if (!session.turnId) return;
      await liveServer(session).request("turn/interrupt", { threadId: session.nativeId, turnId: session.turnId });
    },
    // thread/compact/start on this session's own thread; the harness reports a compaction turn, and this settles
    // when that turn completes. The turn is not a prompt run, so it never emits RUN_STARTED/RUN_FINISHED.
    async compact() {
      if (session.turnId) throw new Error("codex: finish the running turn before compacting");
      if (session.compactWait) throw new Error("codex: a compaction is already running");
      const server = await currentServer(session.pool, session.env);
      if (session.server !== server) await attach(session);
      const wait: Json = { turnId: null, before: null, after: null };
      const done = new Promise((resolve, reject) => {
        wait.timer = setTimeout(() => settleCompact(session, new Error("codex compaction timed out")), COMPACT_MS);
        wait.resolve = resolve;
        wait.reject = reject;
      }).finally(() => {
        clearTimeout(wait.timer);
        if (session.compactWait === wait) session.compactWait = null;
      });
      done.catch(() => {});
      session.compactWait = wait;
      try {
        await server.request("thread/compact/start", { threadId: session.nativeId });
      } catch (error: Json) {
        settleCompact(session, error);
      }
      return done;
    },
    async respond(interruptId: string, decision: Decision) {
      const approval = session.approvals.get(interruptId);
      if (!approval) throw new Error(`no codex approval ${interruptId} is waiting`);
      session.approvals.delete(interruptId);
      const allow = decision.behavior === "allow";
      const result = approval.kind === "item/permissions/requestApproval"
        ? { permissions: allow ? approval.permissions : {}, scope: "turn" }
        : { decision: allow ? "accept" : "decline" };
      session.server.reply(approval.rpcId, result);
      session.ctx.emit({ type: EventType.CUSTOM, name: APPROVAL_RESOLVED, value: { interruptId, status: "resolved", reason: allow ? "allowed" : "denied" } });
    },
    async setPermissionMode(mode: Json) {
      const { settings, error } = permissionSettings("codex", mode, session.place);
      if (error) throw new Error(error);
      session.settings = settings;
      session.mode = mode;
      session.ctx.emit({ type: EventType.STATE_DELTA, delta: [{ op: "replace", path: "/permissionMode", value: mode }] });
    },
    async contextUsage() {
      return session.usage;
    },
    async close() {
      const server = session.server;
      if (!server) return;
      for (const [interruptId, approval] of session.approvals) {
        server.reply(approval.rpcId, approval.kind === "item/permissions/requestApproval" ? { permissions: {}, scope: "turn" } : { decision: "decline" });
        session.approvals.delete(interruptId);
      }
      server.sessions.delete(session.nativeId);
      session.server = null;
      if (session.place === "openshell") server.child.kill();
      else await server.request("thread/unsubscribe", { threadId: session.nativeId }).catch(() => {});
    },
  };
}

/** The session's child, or a clear error once the child has exited or the session closed. */
function liveServer(session: Json) {
  if (!session.server || session.server.exited) throw new Error("the codex app-server is not running; resume the session");
  return session.server;
}

/** Binds the session to the shared child, resuming the thread there after a restart or child exit. */
async function attach(session: Json) {
  const server = await currentServer(session.pool, session.env);
  if (session.server === server) return;
  server.sessions.set(session.nativeId, session);
  try {
    const { thread } = await server.request("thread/resume", {
      threadId: session.nativeId, excludeTurns: true, cwd: session.cwd, ...(session.model ? { model: session.model } : {}), ...threadPolicy(session.settings),
      ...threadConfig(session.codeMode),
    });
    session.rolloutPath = thread?.path || null;
  } catch (error: Json) {
    server.sessions.delete(session.nativeId);
    throw error;
  }
  session.server = server;
}

function newSession({ pool, ctx, env, cwd, place, mode, model, settings, codeMode }: Json) {
  return { pool, ctx, env, cwd, place, mode, model, settings, codeMode, nativeId: "", address: "", server: null, prompt: "", turnId: null, approvals: new Map(), usage: null, compactWait: null,
    codeCalls: new Map(), rolloutPath: null, rolloutOffset: null };
}

async function openThread(pool: Json, options: Json, ctx: SessionContext) {
  const server = await currentServer(pool, options.env);
  const session = newSession({ pool, ctx, env: options.env, cwd: options.cwd, place: options.place, mode: options.permissionMode, model: options.model, settings: options.permission, codeMode: options.codeMode });
  const { thread } = await server.request("thread/start", {
    cwd: options.cwd, ephemeral: false, ...threadPolicy(options.permission), ...(options.model ? { model: options.model } : {}),
    ...threadConfig(options.codeMode), experimentalRawEvents: true,
  });
  session.nativeId = thread.id;
  session.address = `codex#${sessionLabel(thread.id)}`;
  session.server = server;
  server.sessions.set(thread.id, session);
  return makeHandle(session);
}

/** The handle with a close that lands the sandbox work and releases the sandbox, and a syncBack for land finish. */
function boxedHandle(handle: Json, box: CliBox, log: (line: string) => void) {
  let closed = false;
  return {
    ...handle,
    syncBack: () => box.syncBack(log),
    async close() {
      if (closed) return;
      closed = true;
      await handle.close();
      await box.close(log);
    },
  };
}

/**
 * Default export of runner/adapters/codex.ts. `command` overrides the child argv; requestMs the RPC timeout (tests).
 * `sandbox` stages plain OpenShell starts in the project's Codex sandbox; a command override has no install to upload, so it gets none.
 */
export default function codexAdapter({ env = process.env, command = DEFAULT_COMMAND, requestMs = REQUEST_MS, sandbox = command === DEFAULT_COMMAND ? createCodexSandbox({ env }) : null }: {
  env?: NodeJS.ProcessEnv; command?: Json; requestMs?: number; sandbox?: CliSandbox | null;
} = {}) {
  const pool: Json = { command, requestMs, server: null, starting: null, booting: null };
  // Managed sessions share a second app-server with native subagents off and AI_COLLAB_MANAGED in its env (spec answer 5).
  const managedPool: Json = { command: { ...command, args: [...command.args, ...CODEX_NO_SUBAGENT_ARGS] }, requestMs, server: null, starting: null, booting: null };
  // The argv tail a managed session's own launcher gets, so an OpenShell child runs without subagents too.
  const launcherArgs = (args: Json, managed: Json) => (managed ? [...args, ...CODEX_NO_SUBAGENT_ARGS] : args);
  // OpenShell sessions' own app-server pools, so shutdown stops their exec clients too; exited ones are dropped.
  const launched = new Set<Json>();
  function launcherPool(file: string, args: string[]) {
    for (const each of launched) if (each.server?.exited) launched.delete(each);
    const made: Json = { command: { file, args }, requestMs };
    launched.add(made);
    return made;
  }
  // Stages the project's sandbox for one session and returns its box and the app-server argv there.
  async function openBox(project: string, cwd: string, vars: Json, managed: boolean, ctx: SessionContext, resumeId: string | null) {
    if (!sandbox) throw new Error("codex has no OpenShell sandbox in this runner");
    const box = await sandbox.open({ project, cwd, home: vars?.HOME, log: ctx.log, ...(resumeId ? { id: resumeId, resume: true } : {}) });
    return { box, argv: box.argv(APP_SERVER_ARGS, codexSandboxEnv(managed)) };
  }
  async function boxed(box: CliBox, ctx: SessionContext, start: () => Promise<Json>) {
    try {
      return boxedHandle(await start(), box, ctx.log);
    } catch (error) {
      await box.close(ctx.log);
      throw error;
    }
  }
  const adapter = {
    harness: "codex",
    // openshellStarts: whether a start without a builder's launcher can run in OpenShell.
    capabilities: { steer: true, images: false, resume: "transcript", permissionModes: PERMISSION_MODES, places: ["folder", "worktree", "openshell"], openshellStarts: Boolean(sandbox), openshellTeams: false },
    available(probeEnv: Json) {
      return new Promise((resolve) => {
        execFile(command.file, command.version, { env: probeEnv, timeout: 10_000 }, (error, stdout) => {
          resolve(error ? { ok: false, detail: error.message } : { ok: true, detail: stdout.trim() });
        });
      });
    },
    async open(options: Json, ctx: SessionContext) {
      const [file, ...args] = options.sandboxArgv || [];
      const commandAt = args.indexOf("--") + 1;
      if (options.place === "openshell" && (!file || args[0] !== "sandbox" || args[1] !== "exec" || !commandAt || !args[commandAt])) {
        throw new Error("Codex OpenShell sessions require a prepared OpenShell launcher");
      }
      const sessionPool = file ? launcherPool(file, launcherArgs(args, options.managed)) : options.managed ? managedPool : pool;
      const opened = options.place === "openshell" ? { ...options, permission: openshellPermission(options.permission) } : options;
      try {
        return await openThread(sessionPool, opened, ctx);
      } catch (error: Json) {
        if (file) sessionPool.server?.child.kill();
        throw error;
      }
    },
    async resume(record: Json, ctx: SessionContext, resumeEnv: Json, staged: Json) {
      if (record.place === "openshell" && !staged?.argv?.[0]) throw new Error("Codex OpenShell threads require a prepared launcher to resume");
      const { settings, error } = permissionSettings("codex", record.permissionMode, record.place);
      if (error) throw new Error(error);
      const [file, ...args] = staged?.argv ?? [];
      const sessionPool = file ? launcherPool(file, launcherArgs(args, record.managed)) : record.managed ? managedPool : pool;
      const session = newSession({
        pool: sessionPool, ctx, env: resumeEnv, cwd: staged?.workdir ?? record.cwd, place: record.place,
        mode: record.permissionMode, model: record.model, settings: staged ? openshellPermission(settings) : settings, codeMode: record.codeMode,
      });
      session.nativeId = record.nativeId;
      session.address = record.address;
      try {
        await attach(session);
        return makeHandle(session);
      } catch (error: Json) {
        if (file) sessionPool.server?.child.kill();
        throw error;
      }
    },
    async listModels(listEnv: Json) {
      const server = await currentServer(pool, listEnv);
      const models: Json[] = [];
      let cursor: Json = null;
      do {
        const page: Json = await server.request("model/list", cursor ? { cursor } : {});
        models.push(...(page.data || []));
        cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
      } while (cursor);
      return models.filter((m) => !m.hidden).map((m) => ({ id: m.model, label: m.displayName, ...(m.isDefault ? { default: true } : {}) }));
    },
    async listCommands(cwd: string, listEnv: Json) {
      const server = await currentServer(pool, listEnv);
      const page = await server.request("skills/list", { cwds: [cwd] });
      return (page.data || []).flatMap((entry: Json) => entry.skills || []).map((skill: Json) => ({ name: skill.name, description: skill.description }));
    },
    async shutdown() {
      for (const each of [pool, managedPool, ...launched]) {
        const server = each.server;
        each.server = null;
        server?.child.kill();
        each.booting?.child.kill();
        each.booting = null;
      }
    },
    restore: (record: Json) => sandbox?.restore(record),
    release: (record: Json) => (sandbox ? sandbox.release(record) : Promise.resolve(true)),
  };
  if (!sandbox) return adapter;
  const { open, resume } = adapter;
  return {
    ...adapter,
    // A builder start brings its own launcher; a plain one stages the project's sandbox.
    async open(options: Json, ctx: SessionContext) {
      if (options.place !== "openshell" || options.sandboxArgv) return open(options, ctx);
      const { box, argv } = await openBox(options.project, options.cwd, options.env, options.managed === true, ctx, null);
      return boxed(box, ctx, () => open({ ...options, cwd: box.workdir, sandboxArgv: argv }, ctx));
    },
    async resume(record: Json, ctx: SessionContext, resumeEnv: Json, staged: Json) {
      if (record.place !== "openshell" || staged?.argv || record.builder) return resume(record, ctx, resumeEnv, staged);
      const { box, argv } = await openBox(record.project, record.cwd, resumeEnv, record.managed === true, ctx, record.address);
      return boxed(box, ctx, () => resume(record, ctx, resumeEnv, { argv, workdir: box.workdir }));
    },
  };
}
