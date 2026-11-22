// Owned-session adapter for Codex: one `codex app-server` child per runner, frames routed by threadId.
// Method and field names: `codex app-server generate-json-schema` at codex-cli 0.171.0 (see docs/owned-sessions-contract.md).
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { EventType } from "@ag-ui/core";
import { sessionLabel } from "../../lib/config.mjs";
import { CLIENT } from "../../lib/codex-compact.mjs";
import { APPROVAL_REQUESTED, APPROVAL_RESOLVED, ERROR, NOTICE, PERMISSION_MODES, permissionSettings } from "../contract.mjs";

export const APP_SERVER_ARGS = ["app-server", "-c", "thread_unload_delay_secs=0"];
const DEFAULT_COMMAND = { file: "codex", args: APP_SERVER_ARGS, version: ["--version"] };
const REQUEST_MS = 60_000;
const METHOD_NOT_FOUND = -32601;
const SANDBOX_MODE = { readOnly: "read-only", workspaceWrite: "workspace-write", dangerFullAccess: "danger-full-access" };
const APPROVAL_TOOL = {
  "item/commandExecution/requestApproval": "Bash",
  "item/fileChange/requestApproval": "Edit",
  "item/permissions/requestApproval": "Permissions",
};
const FAILED_STATUS = ["failed", "declined"];

/** Thread-level settings for a mode: approval policy, reviewer and the sandbox mode name `thread/start` takes. */
const threadPolicy = (settings) => ({
  approvalPolicy: settings.approvalPolicy,
  approvalsReviewer: settings.approvalsReviewer,
  sandbox: SANDBOX_MODE[settings.sandboxPolicy.type],
});

/** Turn-level settings for a mode: the same policy with the sandbox as an object, as `turn/start` takes it. */
const turnPolicy = (settings) => ({
  approvalPolicy: settings.approvalPolicy,
  approvalsReviewer: settings.approvalsReviewer,
  sandboxPolicy: settings.sandboxPolicy,
});

const userInput = (input) => [{ type: "text", text: input.text, text_elements: [] }];
const text = (value) => (typeof value === "string" ? value : "");

function startServer(pool, env) {
  const { file, args } = pool.command;
  const child = spawn(file, args, { env: { ...env, AI_COLLAB_OWNED: "codex" }, stdio: ["pipe", "pipe", "ignore"], shell: false });
  child.stdin.on("error", () => {});
  const server = { child, pool, nextId: 0, pending: new Map(), sessions: new Map(), exited: false };
  server.write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  server.request = (method, params) => new Promise((resolve, reject) => {
    const id = ++server.nextId;
    const timer = setTimeout(() => {
      server.pending.delete(id);
      const error = new Error(`codex ${method} timed out`);
      error.timedOut = true;
      reject(error);
    }, pool.requestMs);
    server.pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    server.write({ id, method, params });
  });
  server.reply = (id, result) => server.write({ id, result });
  server.fail = (id, message) => server.write({ id, error: { code: METHOD_NOT_FOUND, message } });
  createInterface({ input: child.stdout }).on("line", (line) => route(server, line));
  child.once("error", () => onExit(server));
  child.once("close", () => onExit(server));
  return server;
}

/** Starts the shared child and runs `initialize`; one child serves every thread of the runner. */
async function connectServer(pool, env) {
  const server = startServer(pool, env);
  pool.booting = server; // shutdown kills a child that has not finished its handshake
  try {
    await server.request("initialize", { clientInfo: CLIENT, capabilities: null });
  } catch (error) {
    server.child.kill();
    throw error;
  } finally {
    if (pool.booting === server) pool.booting = null;
  }
  server.write({ method: "initialized" });
  return server;
}

function currentServer(pool, env) {
  if (pool.server && !pool.server.exited) return pool.server;
  pool.starting ??= connectServer(pool, env)
    .then((server) => { pool.server = server; return server; })
    .finally(() => { pool.starting = null; });
  return pool.starting;
}

function route(server, line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method !== undefined && message.id !== undefined) return onServerRequest(server, message);
  if (message.method !== undefined) return onNotification(server, message);
  const waiter = server.pending.get(message.id);
  if (!waiter) return;
  server.pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message || "codex app-server error"));
  else waiter.resolve(message.result);
}

function onExit(server) {
  if (server.exited) return;
  server.exited = true;
  if (server.pool.server === server) server.pool.server = null;
  for (const waiter of server.pending.values()) waiter.reject(new Error("codex app-server exited"));
  server.pending.clear();
  for (const session of server.sessions.values()) {
    if (session.turnId) session.ctx.emit({ type: EventType.RUN_ERROR, message: "codex app-server exited during the run", metadata: { aiCollab: { runId: session.turnId } } });
    for (const interruptId of session.approvals.keys()) session.ctx.emit({ type: EventType.CUSTOM, name: APPROVAL_RESOLVED, value: { interruptId, status: "cancelled", reason: "cancelled" } });
    session.approvals.clear();
    session.turnId = null;
    session.server = null;
  }
  server.sessions.clear();
}

function onNotification(server, { method, params }) {
  const session = server.sessions.get(params?.threadId);
  if (!session) return;
  switch (method) {
    case "turn/started": return turnStarted(session, params.turn);
    case "turn/completed": return turnCompleted(session, params.turn);
    case "item/completed": return itemCompleted(session, params.item);
    case "thread/tokenUsage/updated": return tokenUsage(session, params.tokenUsage);
    case "serverRequest/resolved": return requestResolved(session, params.requestId);
    case "error": return codexError(session, params);
  }
}

function turnStarted(session, turn) {
  session.turnId = turn.id;
  const { emit } = session.ctx;
  emit({
    type: EventType.RUN_STARTED, threadId: session.address, runId: turn.id,
    input: { threadId: session.address, runId: turn.id, tools: [], context: [], messages: [{ id: `${turn.id}:input`, role: "user", content: session.prompt }] },
  });
}

function turnCompleted(session, turn) {
  if (turn.status !== "completed" && turn.status !== "interrupted" && turn.status !== "failed") return;
  session.turnId = null;
  if (turn.status === "failed") {
    // codexErrorInfo is UNVERIFIED: the field name is not in the repo's schema snapshot; lib/limits.mjs reads it for plan limits.
    session.ctx.emit({ type: EventType.RUN_ERROR, message: turn.error?.message || "turn failed", metadata: { aiCollab: { runId: turn.id, codexErrorInfo: turn.error?.codexErrorInfo } } });
    return;
  }
  const type = turn.status === "interrupted" ? "cancelled" : "success";
  session.ctx.emit({ type: EventType.RUN_FINISHED, threadId: session.address, runId: turn.id, outcome: { type } });
}

function itemCompleted(session, item) {
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

function toolCall(session, id, name, input, output, failed) {
  const { emit } = session.ctx;
  emit({ type: EventType.TOOL_CALL_CHUNK, toolCallId: id, toolCallName: name, delta: JSON.stringify(input ?? {}) });
  emit({
    type: EventType.TOOL_CALL_RESULT, toolCallId: id, messageId: `${id}:result`, role: "tool", content: output,
    metadata: { aiCollab: { toolCallName: name, failed } },
  });
}

function tokenUsage(session, usage) {
  const tokens = usage?.last?.totalTokens;
  if (!Number.isSafeInteger(tokens)) return;
  const window = Number.isSafeInteger(usage.modelContextWindow) ? usage.modelContextWindow : undefined;
  session.usage = { tokens, ...(window ? { window } : {}) };
  const delta = [{ op: "replace", path: "/contextTokens", value: tokens }];
  if (window) delta.push({ op: "replace", path: "/contextWindow", value: window });
  session.ctx.emit({ type: EventType.STATE_DELTA, delta });
}

function requestResolved(session, requestId) {
  for (const [interruptId, approval] of session.approvals) {
    if (approval.rpcId !== requestId) continue;
    session.approvals.delete(interruptId);
    session.ctx.emit({ type: EventType.CUSTOM, name: APPROVAL_RESOLVED, value: { interruptId, status: "cancelled", reason: "cancelled" } });
  }
}

function codexError(session, { error, willRetry }) {
  if (willRetry) return;
  session.ctx.emit({ type: EventType.CUSTOM, name: ERROR, value: text(error?.message) || "codex error" });
}

function onServerRequest(server, message) {
  const session = server.sessions.get(message.params?.threadId);
  const tool = APPROVAL_TOOL[message.method];
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

function makeHandle(session) {
  return {
    nativeId: session.nativeId,
    async send(input) {
      if (session.turnId) throw new Error("the codex turn is still running");
      await attach(session);
      session.prompt = input.text;
      // A timed-out turn/start may still have started: the error says so, and the caller never resends.
      const { turn } = await session.server.request("turn/start", {
        threadId: session.nativeId, input: userInput(input), cwd: session.cwd, ...turnPolicy(session.settings),
        ...(session.model ? { model: session.model } : {}),
      }).catch((error) => {
        if (error.timedOut) error.mayHaveStarted = true;
        throw error;
      });
      return { runId: turn.id };
    },
    async steer(input) {
      if (!session.turnId) throw new Error("no codex turn is running to steer");
      await liveServer(session).request("turn/steer", { threadId: session.nativeId, expectedTurnId: session.turnId, input: userInput(input) });
    },
    async interrupt() {
      if (!session.turnId) return;
      await liveServer(session).request("turn/interrupt", { threadId: session.nativeId, turnId: session.turnId });
    },
    async respond(interruptId, decision) {
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
    async setPermissionMode(mode) {
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
      await server.request("thread/unsubscribe", { threadId: session.nativeId }).catch(() => {});
    },
  };
}

/** The session's child, or a clear error once the child has exited or the session closed. */
function liveServer(session) {
  if (!session.server || session.server.exited) throw new Error("the codex app-server is not running; resume the session");
  return session.server;
}

/** Binds the session to the shared child, resuming the thread there after a restart or child exit. */
async function attach(session) {
  const server = await currentServer(session.pool, session.env);
  if (session.server === server) return;
  server.sessions.set(session.nativeId, session);
  try {
    await server.request("thread/resume", {
      threadId: session.nativeId, excludeTurns: true, cwd: session.cwd, ...(session.model ? { model: session.model } : {}), ...threadPolicy(session.settings),
    });
  } catch (error) {
    server.sessions.delete(session.nativeId);
    throw error;
  }
  session.server = server;
}

function newSession({ pool, ctx, env, cwd, place, mode, model, settings }) {
  return { pool, ctx, env, cwd, place, mode, model, settings, nativeId: "", address: "", server: null, prompt: "", turnId: null, approvals: new Map(), usage: null };
}

/** Default export of runner/adapters/codex.mjs. `command` overrides the child argv; requestMs the RPC timeout (tests). */
export default function codexAdapter({ env = {}, command = DEFAULT_COMMAND, requestMs = REQUEST_MS } = {}) {
  const pool = { command, requestMs, server: null, starting: null, booting: null };
  return {
    harness: "codex",
    capabilities: { steer: true, images: false, resume: "transcript", permissionModes: PERMISSION_MODES },
    available(probeEnv) {
      return new Promise((resolve) => {
        execFile(command.file, command.version, { env: probeEnv, timeout: 10_000 }, (error, stdout) => {
          resolve(error ? { ok: false, detail: error.message } : { ok: true, detail: stdout.trim() });
        });
      });
    },
    async open(options, ctx) {
      const server = await currentServer(pool, options.env);
      const session = newSession({ pool, ctx, env: options.env, cwd: options.cwd, place: options.place, mode: options.permissionMode, model: options.model, settings: options.permission });
      const { thread } = await server.request("thread/start", {
        cwd: options.cwd, ephemeral: false, ...threadPolicy(options.permission), ...(options.model ? { model: options.model } : {}),
      });
      session.nativeId = thread.id;
      session.address = `codex#${sessionLabel(thread.id)}`;
      session.server = server;
      server.sessions.set(thread.id, session);
      return makeHandle(session);
    },
    async resume(record, ctx, resumeEnv) {
      const { settings, error } = permissionSettings("codex", record.permissionMode, record.place);
      if (error) throw new Error(error);
      const session = newSession({ pool, ctx, env: resumeEnv, cwd: record.cwd, place: record.place, mode: record.permissionMode, model: record.model, settings });
      session.nativeId = record.nativeId;
      session.address = record.address;
      await attach(session);
      return makeHandle(session);
    },
    async listModels(listEnv) {
      const server = await currentServer(pool, listEnv);
      const models = [];
      let cursor = null;
      do {
        const page = await server.request("model/list", cursor ? { cursor } : {});
        models.push(...(page.data || []));
        cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
      } while (cursor);
      return models.filter((m) => !m.hidden).map((m) => ({ id: m.model, label: m.displayName, ...(m.isDefault ? { default: true } : {}) }));
    },
    async listCommands(cwd, listEnv) {
      const server = await currentServer(pool, listEnv);
      const page = await server.request("skills/list", { cwds: [cwd] });
      return (page.data || []).flatMap((entry) => entry.skills || []).map((skill) => ({ name: skill.name, description: skill.description }));
    },
    async shutdown() {
      const server = pool.server;
      pool.server = null;
      server?.child.kill();
      pool.booting?.child.kill();
      pool.booting = null;
    },
  };
}
