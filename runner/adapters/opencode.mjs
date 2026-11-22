// OpenCode 2 adapter: drives the registered OpenCode service over HTTP and reads its shared /api/event SSE stream.
import { randomUUID } from "node:crypto";
import { EventType } from "@ag-ui/core";
import { sessionLabel } from "../../lib/config.mjs";
import { opencodeRequest, serviceEndpoint } from "../../lib/opencode-api.mjs";
import { APPROVAL_REQUESTED, APPROVAL_RESOLVED, PERMISSION_TABLE } from "../contract.mjs";

const NO_SERVICE = "OpenCode service is not running (no loopback url in its service.json)";
const RETRY_MS = 2000;
const ASK_FALLBACK = "permission";
const enc = encodeURIComponent;

/** The auto-reply actions of a mode (PERMISSION_TABLE.opencode), empty for a mode without them. */
export const autoReplyFor = (mode) => PERMISSION_TABLE.opencode[mode]?.autoReply ?? [];

/** {providerID, modelID} for a "provider/model" name, else undefined. */
export function modelRef(model) {
  const at = typeof model === "string" ? model.indexOf("/") : -1;
  return at > 0 && at < model.length - 1 ? { providerID: model.slice(0, at), modelID: model.slice(at + 1) } : undefined;
}

const autoReplies = (actions, action) => actions.includes("*") || actions.includes(action);
const threadOf = (sessionID) => `opencode#${sessionLabel(sessionID)}`;
const summaryOf = (req) => (typeof req.message === "string" && req.message) || (Array.isArray(req.resources) ? req.resources.map(String).join(" ") : "");
const contentText = (content) => (typeof content === "string" ? content : JSON.stringify(content ?? ""));
const errorText = (data) => (typeof data.error === "string" && data.error) || data.error?.message || data.message || "OpenCode run failed";
const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

/** The `data:` payload of each event in an SSE body. */
export async function* sseData(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  let data = [];
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (line === "") {
        if (data.length) yield data.join("\n");
        data = [];
      } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
  }
}

export default function openCodeAdapter({ env = process.env } = {}) {
  return createOpenCodeAdapter({ env });
}

/** An adapter over the OpenCode service that env locates; retryMs paces event-stream reconnects. */
export function createOpenCodeAdapter({ env = process.env, retryMs = RETRY_MS } = {}) {
  const sessions = new Map(); // OpenCode session id -> {sessionID, ctx, threadId, autoReply, run, tools}
  const pending = new Map(); // open approval request id -> {sessionID (asking session), owner (owned session id), action}
  const inflight = new Set(); // approval ids being auto-replied
  const answering = new Set(); // approval ids whose reply POST is in flight
  let stream = null; // {ac}: the one /api/event subscription every session shares

  const service = () => serviceEndpoint(env);

  async function call(method, path, body) {
    const r = await opencodeRequest(method, path, { body, env });
    if (!r.ok) throw new Error(`OpenCode ${method} ${path} failed: ${r.error}`);
    return r.body;
  }

  // The session that asked: a subagent child of an owned session asks under its own id.
  const askerOf = (s, req) => (typeof req.sessionID === "string" && req.sessionID ? req.sessionID : s.sessionID);

  function surface(s, req) {
    pending.set(req.id, { sessionID: askerOf(s, req), owner: s.sessionID, action: String(req.action || ASK_FALLBACK) });
    s.ctx.emit({
      type: EventType.CUSTOM, name: APPROVAL_REQUESTED,
      value: { interruptId: req.id, reason: "tool_approval", toolCallName: String(req.action || ASK_FALLBACK), summary: summaryOf(req) },
    });
  }

  // An ask the mode auto-answers gets `once`; a failed auto-reply falls back to an approval card.
  function ask(s, req) {
    if (!req?.id || pending.has(req.id) || inflight.has(req.id) || answering.has(req.id)) return;
    if (!autoReplies(s.autoReply, req.action)) return surface(s, req);
    inflight.add(req.id);
    call("POST", `/api/session/${enc(askerOf(s, req))}/permission/${enc(req.id)}/reply`, { decision: "once" })
      .catch(() => surface(s, req))
      .finally(() => inflight.delete(req.id));
  }

  // Answers an open approval; the entry leaves `pending` first so the reply event does not resolve it twice.
  // `answering` keeps a resync from raising a second card while the reply is in flight.
  async function answer(id, body) {
    const entry = pending.get(id);
    pending.delete(id);
    answering.add(id);
    try {
      await call("POST", `/api/session/${enc(entry.sessionID)}/permission/${enc(id)}/reply`, body);
    } catch (error) {
      pending.set(id, entry);
      throw error;
    } finally {
      answering.delete(id);
    }
  }

  // The execution id of a session.execution.* event; "" when the event carries none.
  const executionOf = (data) => String(data.executionID ?? "");
  // Once our execution has started, only its completion ends the run. Before that, a completion ends it (existing test).
  const ours = (s, data) => Boolean(s.run) && (!s.run.started || s.run.execution === executionOf(data));

  function runStarted(s, data) {
    const run = s.run;
    if (!run || run.started) return;
    run.started = true;
    run.execution = executionOf(data);
    s.ctx.emit({
      type: EventType.RUN_STARTED, threadId: s.threadId, runId: run.runId,
      input: { threadId: s.threadId, runId: run.runId, tools: [], context: [], messages: [{ id: `${run.runId}:input`, role: "user", content: run.text }] },
    });
  }

  // Ends the run this handle started; executions it did not start emit nothing.
  function endRun(s, toEvent) {
    const run = s.run;
    if (!run) return;
    s.run = null;
    s.ctx.emit(toEvent(run.runId));
  }

  function toolResult(s, data, failed) {
    if (!s.run) return;
    s.ctx.emit({
      type: EventType.TOOL_CALL_RESULT, toolCallId: data.callID, messageId: `${data.callID}:result`, role: "tool",
      content: failed ? errorText(data) : contentText(data.content),
      metadata: { aiCollab: { toolCallName: s.tools.get(data.callID) ?? "tool", failed } },
    });
  }

  function replied(data) {
    const entry = pending.get(data.requestID);
    if (!entry) return;
    pending.delete(data.requestID);
    sessions.get(entry.owner)?.ctx.emit({
      type: EventType.CUSTOM, name: APPROVAL_RESOLVED,
      value: { interruptId: data.requestID, status: "resolved", reason: data.reply === "reject" ? "denied" : "allowed" },
    });
  }

  function dispatch(event) {
    const data = event?.data ?? {};
    if (event?.type === "permission.replied") return replied(data);
    // An ask from a subagent child (parentID names the owned session) is handled for the owned session.
    const asked = event?.type === "permission.asked";
    const s = sessions.get(data.sessionID) ?? (asked ? sessions.get(data.parentID) : undefined);
    if (!s || (!asked && s.sessionID !== data.sessionID)) return;
    switch (event.type) {
      case "permission.asked": return ask(s, data);
      case "session.execution.started": return runStarted(s, data);
      case "session.execution.succeeded":
        return ours(s, data) && endRun(s, (runId) => ({ type: EventType.RUN_FINISHED, threadId: s.threadId, runId, outcome: { type: "success" } }));
      case "session.execution.interrupted":
        return ours(s, data) && endRun(s, (runId) => ({ type: EventType.RUN_FINISHED, threadId: s.threadId, runId, outcome: { type: "cancelled" } }));
      case "session.execution.failed":
        return ours(s, data) && endRun(s, (runId) => ({ type: EventType.RUN_ERROR, message: errorText(data), metadata: { aiCollab: { runId } } }));
      case "session.text.ended":
        if (s.run) s.ctx.emit({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: data.assistantMessageID, role: "assistant", delta: String(data.text ?? "") });
        return;
      case "session.tool.called":
        if (!s.run) return;
        s.tools.set(data.callID, String(data.name));
        return s.ctx.emit({ type: EventType.TOOL_CALL_CHUNK, toolCallId: data.callID, toolCallName: String(data.name), delta: JSON.stringify(data.input ?? {}) });
      case "session.tool.success": return toolResult(s, data, false);
      case "session.tool.failed": return toolResult(s, data, true);
      case "session.compaction.started":
        return s.ctx.emit({ type: EventType.STEP_STARTED, stepName: "compact", metadata: { aiCollab: { compaction: { trigger: data.reason, phase: "started" } } } });
      case "session.compaction.ended":
        return s.ctx.emit({ type: EventType.STEP_FINISHED, stepName: "compact", metadata: { aiCollab: { compaction: { phase: "finished" } } } });
      case "session.compaction.failed":
        return s.ctx.emit({ type: EventType.STEP_FINISHED, stepName: "compact", metadata: { aiCollab: { compaction: { phase: "failed" } } } });
    }
  }

  // Events missed while the stream was down: an idle session ends its open run; asks the server no longer lists close.
  async function resync() {
    for (const s of [...sessions.values()]) {
      if (s.run) {
        const status = await opencodeRequest("GET", `/api/session/${enc(s.sessionID)}`, { env });
        if (status.ok && status.body?.data?.status === "idle") {
          endRun(s, (runId) => ({ type: EventType.RUN_ERROR, message: "the OpenCode run ended while the event stream was down", metadata: { aiCollab: { runId } } }));
        }
      }
      const r = await opencodeRequest("GET", `/api/session/${enc(s.sessionID)}/permission`, { env });
      if (!r.ok || !Array.isArray(r.body?.data)) continue;
      const listed = new Set(r.body.data.map((req) => req?.id));
      for (const [id, entry] of [...pending]) {
        if (entry.owner !== s.sessionID || entry.sessionID !== s.sessionID || listed.has(id) || answering.has(id)) continue;
        pending.delete(id);
        s.ctx.emit({ type: EventType.CUSTOM, name: APPROVAL_RESOLVED, value: { interruptId: id, status: "cancelled", reason: "cancelled" } });
      }
      for (const req of r.body.data) ask(s, req);
    }
  }

  function ensureStream() {
    if (stream) return;
    const ac = new AbortController();
    stream = { ac };
    listen(ac).catch(() => {});
  }

  async function listen(ac) {
    const { signal } = ac;
    while (!signal.aborted && sessions.size) {
      try {
        const ep = service();
        if (!ep) throw new Error(NO_SERVICE);
        const res = await fetch(`${ep.url}/api/event`, {
          headers: { accept: "text/event-stream", ...(ep.auth ? { authorization: ep.auth } : {}) }, signal,
        });
        if (!res.ok) throw new Error(`event stream answered ${res.status}`);
        await resync();
        for await (const data of sseData(res.body)) {
          try { dispatch(JSON.parse(data)); } catch { /* a malformed event is skipped */ }
        }
      } catch (error) {
        if (signal.aborted) break;
        for (const s of sessions.values()) s.ctx.log(`OpenCode event stream: ${error.message}; reconnecting`);
      }
      if (!signal.aborted) await sleep(retryMs, signal);
    }
    // No await between the loop test and this reset, so ensureStream never sees a stale stream.
    if (stream?.ac === ac) stream = null;
  }

  function attach(sessionID, ctx, autoReply) {
    const s = { sessionID, ctx, threadId: threadOf(sessionID), autoReply, run: null, tools: new Map() };
    sessions.set(sessionID, s);
    ensureStream();
    return handleFor(s);
  }

  function handleFor(s) {
    const path = `/api/session/${enc(s.sessionID)}`;
    return {
      nativeId: s.sessionID,
      async send(input) {
        if (s.run) throw new Error("a run is already running");
        const run = { runId: randomUUID(), text: input.text, started: false };
        s.run = run;
        try {
          await call("POST", `${path}/prompt`, { text: input.text, delivery: "queue", resume: true });
        } catch (error) {
          if (s.run === run) s.run = null;
          throw error;
        }
        return { runId: run.runId };
      },
      async steer(input) {
        await call("POST", `${path}/prompt`, { text: input.text, delivery: "steer", resume: true });
      },
      async interrupt() {
        const run = s.run;
        if (!run) return;
        await call("POST", `${path}/interrupt`);
        if (s.run === run) {
          s.run = null;
          s.ctx.emit({ type: EventType.RUN_FINISHED, threadId: s.threadId, runId: run.runId, outcome: { type: "cancelled" } });
        }
      },
      async respond(interruptId, decision) {
        const entry = pending.get(interruptId);
        if (!entry || entry.owner !== s.sessionID) throw new Error("no open OpenCode approval with that id");
        if (decision.answers) throw new Error("OpenCode approvals take allow or deny, not answers");
        const body = decision.behavior === "allow" ? { decision: "once" } : { decision: "reject", message: decision.message };
        await answer(interruptId, body);
      },
      async setPermissionMode(mode) {
        if (!PERMISSION_TABLE.opencode[mode]) throw new Error(`OpenCode has no permission mode ${mode}`);
        s.autoReply = autoReplyFor(mode);
        for (const [id, entry] of [...pending]) {
          if (entry.owner === s.sessionID && autoReplies(s.autoReply, entry.action)) {
            await answer(id, { decision: "once" }).catch(() => {});
          }
        }
      },
      async close() {
        if (sessions.get(s.sessionID) === s) sessions.delete(s.sessionID);
        for (const [id, entry] of [...pending]) if (entry.owner === s.sessionID) pending.delete(id);
        s.run = null;
        if (!sessions.size && stream) {
          stream.ac.abort();
          stream = null;
        }
      },
    };
  }

  return {
    harness: "opencode",
    capabilities: { steer: true, images: false, resume: "transcript", permissionModes: Object.keys(PERMISSION_TABLE.opencode) },
    async available() {
      if (!service()) return { ok: false, detail: NO_SERVICE };
      const r = await opencodeRequest("GET", "/api/info", { env });
      return r.ok ? { ok: true } : { ok: false, detail: r.error };
    },
    async open(options, ctx) {
      const model = modelRef(options.model);
      const created = await call("POST", "/api/session", { location: { directory: options.cwd }, ...(model ? { model } : {}) });
      const id = created?.data?.id;
      if (typeof id !== "string" || !id) throw new Error("OpenCode created no session");
      return attach(id, ctx, options.permission?.autoReply ?? []);
    },
    async resume(record, ctx) {
      await call("GET", `/api/session/${enc(record.nativeId)}`);
      return attach(record.nativeId, ctx, autoReplyFor(record.permissionMode));
    },
    async listModels() {
      const body = await call("GET", "/api/model");
      return (Array.isArray(body?.data) ? body.data : []).flatMap((m) => {
        const modelID = m?.id ?? m?.modelID;
        return typeof m?.providerID === "string" && typeof modelID === "string" ? [{ id: `${m.providerID}/${modelID}` }] : [];
      });
    },
    async listCommands() {
      const body = await call("GET", "/api/command");
      return (Array.isArray(body?.data) ? body.data : []).flatMap((c) =>
        typeof c?.name === "string" ? [{ name: c.name, ...(typeof c.description === "string" ? { description: c.description } : {}) }] : []);
    },
    async shutdown() {
      stream?.ac.abort();
      stream = null;
      sessions.clear();
      pending.clear();
    },
  };
}
