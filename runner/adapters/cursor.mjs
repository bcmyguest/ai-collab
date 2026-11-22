// Cursor adapter: one `cursor-agent acp` child per owned session over stdio JSON-RPC, optionally inside an OpenShell sandbox.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventType } from "@ag-ui/core";
import { sessionLabel } from "../../lib/config.mjs";
import { APPROVAL_REQUESTED, APPROVAL_RESOLVED, permissionSettings } from "../contract.mjs";

// UNVERIFIED: ACP protocolVersion 1 and the method names follow the ACP spec, not a schema dump from cursor-agent.
const PROTOCOL_VERSION = 1;
const SETUP_TIMEOUT_MS = 30_000;
const TOOL_TIMEOUT_MS = 60_000;
const SANDBOX_TIMEOUT_MS = 600_000;
const CLIENT = { name: "ai-collab-runner", version: "0" };
const OWNED = { AI_COLLAB_OWNED: "cursor" };

/** The OpenShell sandbox name for a project: ai-collab-<project>, lowercase, at most 40 characters of project. */
export const sandboxName = (project) =>
  `ai-collab-${project.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)}`;

/** Argv of the ACP server: `acp`, then `--force` when the mode asks for it, then `--model` when one is named. */
export function acpArgs({ force = false, model } = {}) {
  return ["acp", ...(force ? ["--force"] : []), ...(model ? ["--model", model] : [])];
}

/** Argv that runs cursor-agent inside a sandbox: `openshell sandbox exec` with stdin piped and the owned marker set. */
export function execArgv({ openshell, sandbox, args }) {
  return [openshell, "sandbox", "exec", "--no-tty", "-n", sandbox, "--env", "AI_COLLAB_OWNED=cursor", "--", "cursor-agent", ...args];
}

/** Runs a short-lived tool to completion; never rejects, so a missing binary reports through `stderr`. */
export function runTool(bin, args, { env, cwd, timeoutMs = SETUP_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env, cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** Creates the project's sandbox when missing, starts it when stopped, and resumes it when suspended. */
export async function ensureSandbox({ openshell, env, project }) {
  const name = sandboxName(project);
  const list = await runTool(openshell, ["sandbox", "list", "-o", "json"], { env, timeoutMs: SETUP_TIMEOUT_MS });
  if (list.code !== 0) throw new Error(`openshell sandbox list failed: ${list.stderr.trim() || `exit ${list.code}`}`);
  let sandboxes;
  try { sandboxes = JSON.parse(list.stdout).sandboxes ?? []; } catch { throw new Error("openshell sandbox list printed no JSON"); }
  const found = sandboxes.find((s) => s.name === name);
  const step = found ? stateCommand(found) : ["create", "--name", name, "--no-tty", "--detach"];
  if (!step) return name;
  const out = await runTool(openshell, ["sandbox", ...step], { env, timeoutMs: SANDBOX_TIMEOUT_MS });
  if (out.code !== 0) throw new Error(`openshell sandbox ${step[0]} failed: ${out.stderr.trim() || `exit ${out.code}`}`);
  return name;
}

// UNVERIFIED: the sandbox JSON field names (phase, state, status) come from no local schema dump; no sandbox exists to inspect.
function stateCommand(sandbox) {
  const state = String(sandbox.phase ?? sandbox.state ?? sandbox.status?.phase ?? sandbox.status ?? "");
  if (/suspend/i.test(state)) return ["resume", sandbox.name];
  if (/stop/i.test(state)) return ["start", sandbox.name];
  return null;
}

function forceOf(permission, place) {
  const force = permission?.force === true;
  if (force && place !== "openshell") throw new Error("cursor full-access runs only in openshell");
  return force;
}

// One ACP connection: newline-delimited JSON-RPC 2.0 over the child's stdio.
function connect(argv, { env, cwd, log, onRequest, onNotify }) {
  const child = spawn(argv[0], argv.slice(1), { env, cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  let dead = null;
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (line.trim()) dispatch(line);
    }
  });
  child.stderr.on("data", (chunk) => { for (const line of chunk.split("\n")) if (line.trim()) log(line.trimEnd()); });
  child.on("error", (error) => fail(error));
  child.on("exit", (code, signal) => fail(new Error(`cursor-agent acp exited (${signal ?? `code ${code}`})`)));

  function send(message) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }
  function dispatch(line) {
    let message;
    try { message = JSON.parse(line); } catch { log(`ignored non-JSON line from cursor-agent: ${line.slice(0, 200)}`); return; }
    if (message.method !== undefined && message.id !== undefined) return onRequest(message);
    if (message.method !== undefined) return onNotify(message.method, message.params ?? {});
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message ?? "ACP error"));
    else waiter.resolve(message.result);
  }
  function fail(error) {
    if (dead) return;
    dead = error;
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    pending.clear();
  }

  return {
    pid: child.pid,
    get dead() { return dead; },
    request(method, params, timeoutMs) {
      if (dead) return Promise.reject(dead);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = timeoutMs ? setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs) : null;
        pending.set(id, { resolve, reject, timer });
        send({ id, method, params });
      });
    },
    notify: (method, params) => send({ method, params }),
    reply: (id, result) => send({ id, result }),
    replyError: (id, code, message) => send({ id, error: { code, message } }),
    kill: () => { child.kill("SIGTERM"); },
    child,
  };
}

/** Maps AG-UI output for one harness session: a run, its text and tool calls, and its approval cards. */
export default function cursorAdapter(config = {}) {
  const cursorBin = config.env?.AI_COLLAB_CURSOR_BIN || "cursor-agent";
  const openshellBin = config.env?.AI_COLLAB_OPENSHELL_BIN || "openshell";
  const connections = new Set();

  // Starts the ACP child (inside the sandbox for openshell) and negotiates initialize; returns the session state.
  async function attach(spec, ctx) {
    const force = forceOf(spec.permission, spec.place);
    const cursorArgs = acpArgs({ force, model: spec.model });
    const env = { ...spec.env, ...OWNED };
    let argv;
    if (spec.place === "openshell") {
      const sandbox = await ensureSandbox({ openshell: openshellBin, env, project: spec.project });
      argv = execArgv({ openshell: openshellBin, sandbox, args: cursorArgs });
    } else {
      argv = [cursorBin, ...cursorArgs];
    }
    const session = { sessionId: null, run: null, approvals: new Map(), tools: new Map(), closed: false, ctx };
    const conn = connect(argv, {
      env,
      cwd: spec.place === "openshell" ? undefined : spec.cwd,
      log: (line) => ctx.log(line),
      onRequest: (message) => handleRequest(session, conn, message),
      onNotify: (method, params) => handleNotify(session, method, params),
    });
    connections.add(conn);
    ctx.signal.addEventListener("abort", () => conn.kill(), { once: true });
    try {
      const init = await conn.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: CLIENT,
      }, SETUP_TIMEOUT_MS);
      if (spec.requireLoad && !init?.agentCapabilities?.loadSession) throw new Error("cursor-agent does not advertise loadSession; the session cannot resume");
      return { conn, session };
    } catch (error) {
      conn.kill();
      connections.delete(conn);
      throw error;
    }
  }

  function handleRequest(session, conn, message) {
    if (message.method === "session/request_permission") return askPermission(session, conn, message);
    conn.replyError(message.id, -32601, `ai-collab does not serve ${message.method}`);
  }

  function handleNotify(session, method, params) {
    if (method !== "session/update" || !session.run) return;
    const update = params.update ?? {};
    const run = session.run;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content?.type === "text" && typeof update.content.text === "string") run.text += update.content.text;
        return;
      case "tool_call": {
        if (typeof update.toolCallId !== "string") return;
        flushText(session, run);
        const toolCallName = update.title || update.kind || "tool";
        session.tools.set(update.toolCallId, toolCallName);
        session.ctx.emit({
          type: EventType.TOOL_CALL_CHUNK, toolCallId: update.toolCallId, toolCallName,
          delta: JSON.stringify(update.rawInput ?? {}, null, 2),
        });
        return;
      }
      case "tool_call_update": {
        if (typeof update.toolCallId !== "string" || !["completed", "failed"].includes(update.status)) return;
        const failed = update.status === "failed";
        session.ctx.emit({
          type: EventType.TOOL_CALL_RESULT, toolCallId: update.toolCallId, messageId: `${update.toolCallId}:result`, role: "tool",
          content: resultText(update, failed),
          metadata: { aiCollab: { toolCallName: session.tools.get(update.toolCallId) ?? "tool", failed } },
        });
        session.tools.delete(update.toolCallId);
        return;
      }
      default:
        return;
    }
  }

  function askPermission(session, conn, message) {
    const toolCall = message.params?.toolCall ?? {};
    const options = message.params?.options ?? [];
    const interruptId = randomUUID();
    const toolCallName = toolCall.title || toolCall.kind || "tool";
    const input = toolCall.rawInput === undefined ? "" : `: ${JSON.stringify(toolCall.rawInput).slice(0, 1000)}`;
    session.approvals.set(interruptId, { rpcId: message.id, conn, options });
    session.ctx.emit({
      type: EventType.CUSTOM, name: APPROVAL_REQUESTED,
      value: { interruptId, reason: "tool_approval", toolCallId: toolCall.toolCallId, toolCallName, summary: `${toolCallName}${input}` },
    });
  }

  function respond(session, interruptId, decision) {
    const approval = session.approvals.get(interruptId);
    if (!approval) return;
    session.approvals.delete(interruptId);
    const allow = decision.behavior === "allow";
    const option = approval.options.find((o) => o.kind === (allow ? "allow_once" : "reject_once"));
    if (option) {
      approval.conn.reply(approval.rpcId, { outcome: { outcome: "selected", optionId: option.optionId } });
      session.ctx.emit({ type: EventType.CUSTOM, name: APPROVAL_RESOLVED, value: { interruptId, status: "resolved", reason: allow ? "allowed" : "denied" } });
    } else {
      approval.conn.reply(approval.rpcId, { outcome: { outcome: "cancelled" } });
      session.ctx.emit({ type: EventType.CUSTOM, name: APPROVAL_RESOLVED, value: { interruptId, status: "cancelled", reason: "cancelled" } });
    }
  }

  function cancelApprovals(session) {
    for (const interruptId of [...session.approvals.keys()]) respond(session, interruptId, { behavior: "deny" });
  }

  function flushText(session, run) {
    if (!run.text) return;
    session.ctx.emit({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: `${run.runId}:m${++run.messageSeq}`, role: "assistant", delta: run.text });
    run.text = "";
  }

  function endRun(session, run, outcome) {
    flushText(session, run);
    cancelApprovals(session);
    session.run = null;
    session.ctx.emit({ type: EventType.RUN_FINISHED, threadId: threadOf(session), runId: run.runId, outcome: { type: outcome } });
  }

  function failRun(session, run, error) {
    cancelApprovals(session);
    session.run = null;
    session.ctx.emit({ type: EventType.RUN_ERROR, message: error.message, metadata: { aiCollab: { runId: run.runId } } });
  }

  const threadOf = (session) => `cursor#${sessionLabel(session.sessionId)}`;

  function makeHandle({ conn, session }) {
    return {
      get nativeId() { return session.sessionId; },
      async send(input) {
        if (session.run) throw new Error("a cursor run is already running");
        if (conn.dead) throw conn.dead;
        const runId = randomUUID();
        const run = { runId, text: "", messageSeq: 0 };
        session.run = run;
        session.ctx.emit({
          type: EventType.RUN_STARTED, threadId: threadOf(session), runId,
          input: { threadId: threadOf(session), runId, tools: [], context: [], messages: [{ id: `${runId}:input`, role: "user", content: input.text }] },
        });
        conn.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: input.text }] }, null)
          .then((result) => endRun(session, run, result?.stopReason === "cancelled" ? "cancelled" : "success"),
            (error) => failRun(session, run, error));
        return { runId };
      },
      async interrupt() {
        if (!session.run) return;
        conn.notify("session/cancel", { sessionId: session.sessionId });
        cancelApprovals(session);
      },
      async respond(interruptId, decision) { respond(session, interruptId, decision); },
      // UNVERIFIED: session/set_model is in cursor-agent 2026.11.22's ACP dispatcher; the params follow the ACP spec. Not called live.
      async setModel(modelId) {
        if (conn.dead) throw conn.dead;
        return conn.request("session/set_model", { sessionId: session.sessionId, modelId }, TOOL_TIMEOUT_MS);
      },
      async close() {
        if (session.closed) return;
        session.closed = true;
        if (session.run) conn.notify("session/cancel", { sessionId: session.sessionId });
        cancelApprovals(session);
        conn.kill();
        connections.delete(conn);
      },
    };
  }

  return {
    harness: "cursor",
    capabilities: { steer: false, images: false, resume: "transcript", permissionModes: ["supervised", "full-access"] },

    async available(env = {}) {
      const out = await runTool(cursorBin, ["--version"], { env });
      return out.code === 0 ? { ok: true, detail: out.stdout.trim() } : { ok: false, detail: out.stderr.trim() || `${cursorBin} exited ${out.code}` };
    },

    async open(options, ctx) {
      const attached = await attach({ ...options, requireLoad: false }, ctx);
      try {
        const created = await attached.conn.request("session/new", { cwd: options.cwd, mcpServers: [] }, SETUP_TIMEOUT_MS);
        attached.session.sessionId = created.sessionId;
        return makeHandle(attached);
      } catch (error) {
        attached.conn.kill();
        connections.delete(attached.conn);
        throw error;
      }
    },

    async resume(record, ctx, env) {
      const settings = permissionSettings("cursor", record.permissionMode, record.place);
      if (settings.error) throw new Error(settings.error);
      const attached = await attach({
        project: record.project, cwd: record.cwd, place: record.place, permission: settings.settings,
        model: record.model, env, requireLoad: true,
      }, ctx);
      try {
        attached.session.sessionId = record.nativeId;
        await attached.conn.request("session/load", { sessionId: record.nativeId, cwd: record.cwd, mcpServers: [] }, TOOL_TIMEOUT_MS);
        return makeHandle(attached);
      } catch (error) {
        attached.conn.kill();
        connections.delete(attached.conn);
        throw error;
      }
    },

    // UNVERIFIED: the `--list-models` output format; lines are read as "<id>" or "<id> - <label>".
    async listModels(env = {}) {
      const out = await runTool(cursorBin, ["--list-models"], { env, timeoutMs: TOOL_TIMEOUT_MS });
      if (out.code !== 0) throw new Error(`${cursorBin} --list-models failed: ${out.stderr.trim() || `exit ${out.code}`}`);
      return out.stdout.split("\n").map((l) => l.trim()).filter((l) => l && !/^(available|tip|loading)/i.test(l))
        .map((l) => { const [id, ...label] = l.split(/\s+-\s+/); return label.length ? { id, label: label.join(" - ") } : { id }; });
    },

    async listCommands() { return []; },

    async shutdown() {
      for (const conn of connections) conn.kill();
      connections.clear();
    },
  };
}

// Text of a finished tool call: the text content blocks, else the raw output, else a status word.
function resultText(update, failed) {
  const blocks = Array.isArray(update.content) ? update.content : [];
  const text = blocks.map((b) => (b?.type === "content" && b.content?.type === "text" ? b.content.text : "")).join("");
  if (text) return text;
  if (typeof update.rawOutput === "string" && update.rawOutput) return update.rawOutput;
  return failed ? "failed" : "completed";
}
