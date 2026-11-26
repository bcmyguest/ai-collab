// Claude adapter: one Agent SDK query() per owned session (docs/owned-sessions-contract.md, "Adapter interface").
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { EventType } from "@ag-ui/core";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { sessionLabel } from "../../lib/config.mjs";
import { childEnv, findExecutable } from "../../lib/start.mjs";
import { classifyLimit } from "../../lib/limits.ts";
import { claudeCodeModeSettings } from "../../lib/code-mode.mjs";
import { APPROVAL_REQUESTED, APPROVAL_RESOLVED, LIMIT, PERMISSION_MODES, permissionSettings } from "../contract.mjs";

// Env marker on the CLI child; hooks stand down by the owned record, this names the harness that spawned the child.
export const OWNED_ENV = "AI_COLLAB_OWNED";
const ASK_QUESTION = "AskUserQuestion";
const HANDSHAKE_MS = 60_000;
const COMPACT_MS = 5 * 60_000;

/** A push-based async iterable: the SDK reads user messages from it, and end() closes it. */
export function inputQueue() {
  const items = [];
  let wake = null;
  let ended = false;
  return {
    push(message) { items.push(message); wake?.(); wake = null; },
    end() { ended = true; wake?.(); wake = null; },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) { yield items.shift(); continue; }
        if (ended) return;
        await new Promise((resolve) => { wake = resolve; });
      }
    },
  };
}

const textOf = (content) => (typeof content === "string" ? content
  : (Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : ""));

/** A one-line description of a tool call for the approval card. */
export function summarize(toolName, input) {
  if (typeof input?.command === "string") return input.command;
  if (typeof input?.file_path === "string") return `${toolName} ${input.file_path}`;
  return `${toolName} ${JSON.stringify(input ?? {}).slice(0, 500)}`;
}

/** An SDKUserMessage carrying the input's text and images. */
async function userMessage(input, priority) {
  const images = await Promise.all((input.images || []).map(async (image) => ({
    type: "image",
    source: { type: "base64", media_type: image.mime, data: (await readFile(image.path)).toString("base64") },
  })));
  const content = images.length ? [...images, { type: "text", text: input.text }] : input.text;
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, ...(priority ? { priority } : {}) };
}

/** Starts one session's query and message pump; attach() awaits the handshake before the handle is used. */
function startSession({ query, ctx, nativeId, cwd, model, permission, env, resume, codeMode }) {
  const threadId = `claude#${sessionLabel(nativeId)}`;
  const inputs = inputQueue();
  const pending = new Map();
  const toolNames = new Map();
  // Watchers for an in-flight compact(), fed every message before the run/approval branches.
  const compactWatch = new Set();
  let run = null;
  let closed = false;
  let ended = false;

  const q = query({
    prompt: inputs,
    options: {
      cwd,
      env: { ...env, [OWNED_ENV]: "claude", AI_COLLAB_PARENT: threadId },
      permissionMode: permission.permissionMode,
      canUseTool: (toolName, input, extra) => canUseTool(toolName, input, extra),
      ...(model ? { model } : {}),
      // Flag settings are the only layer a headless Claude reads code mode from (lib/code-mode.mjs).
      ...(typeof codeMode === "boolean" ? { settings: claudeCodeModeSettings(codeMode) } : {}),
      ...(resume ? { resume: nativeId } : { sessionId: nativeId }),
    },
  });

  // Settles one approval: the SDK gets the decision, and the card gets its resolution event once.
  function settle(interruptId, decision, value) {
    const card = pending.get(interruptId);
    if (!card) return;
    pending.delete(interruptId);
    card.signal?.removeEventListener("abort", card.onAbort);
    ctx.emit({ type: EventType.CUSTOM, name: APPROVAL_RESOLVED, value: { interruptId, ...value } });
    card.resolve(decision);
  }

  function cancelPending(status) {
    for (const interruptId of [...pending.keys()]) {
      settle(interruptId, { behavior: "deny", message: "the run was cancelled" }, { status, reason: "cancelled" });
    }
  }

  function finishRun({ error }) {
    const finished = run;
    run = null;
    if (!finished) return;
    if (error) ctx.emit({ type: EventType.RUN_ERROR, message: error, metadata: { aiCollab: { runId: finished.runId } } });
    else ctx.emit({ type: EventType.RUN_FINISHED, threadId, runId: finished.runId, outcome: { type: finished.cancelled ? "cancelled" : "success" } });
  }

  function canUseTool(toolName, input, { signal, toolUseID }) {
    const interruptId = randomUUID();
    const question = toolName === ASK_QUESTION;
    ctx.emit({
      type: EventType.CUSTOM, name: APPROVAL_REQUESTED,
      value: {
        interruptId, reason: question ? "question" : "tool_approval", toolCallId: toolUseID, toolCallName: toolName,
        summary: summarize(toolName, input), ...(question ? { questions: input.questions ?? [] } : {}),
      },
    });
    return new Promise((resolve) => {
      const onAbort = () => cancelPending("cancelled");
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.set(interruptId, { resolve, signal, onAbort, question, input });
    });
  }

  // The operator's answer to an approval card, by interruptId; an unknown id is ignored.
  function respond(interruptId, decision) {
    const card = pending.get(interruptId);
    if (!card) return;
    if (decision.behavior !== "allow") {
      settle(interruptId, { behavior: "deny", message: decision.message || "denied by the operator" }, { status: "resolved", reason: "denied" });
      return;
    }
    const reason = card.question ? "answered" : "allowed";
    const updatedInput = card.question ? { ...card.input, answers: decision.answers ?? {} } : card.input;
    settle(interruptId, { behavior: "allow", updatedInput }, { status: "resolved", reason });
  }

  function onMessage(msg) {
    // A compaction in flight sees the boundary and status messages before anything else claims them.
    if (compactWatch.size) for (const watch of [...compactWatch]) watch(msg);
    const attribution = msg.parent_tool_use_id ? { subagentRunId: msg.parent_tool_use_id } : {};
    if (msg.type === "assistant") {
      msg.message.content.forEach((block, index) => {
        if (block.type === "text" && block.text) {
          ctx.emit({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: `${msg.uuid}:${index}`, role: "assistant", delta: block.text, ...attribution });
        } else if (block.type === "tool_use") {
          toolNames.set(block.id, block.name);
          ctx.emit({ type: EventType.TOOL_CALL_CHUNK, toolCallId: block.id, toolCallName: block.name, delta: JSON.stringify(block.input, null, 2), ...attribution });
        }
      });
    } else if (msg.type === "user" && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block.type !== "tool_result") continue;
        ctx.emit({
          type: EventType.TOOL_CALL_RESULT, toolCallId: block.tool_use_id, messageId: `${block.tool_use_id}:result`, role: "tool",
          content: textOf(block.content),
          metadata: { aiCollab: { toolCallName: toolNames.get(block.tool_use_id) || "tool", failed: block.is_error === true } },
          ...attribution,
        });
      }
    } else if (msg.type === "system" && msg.subtype === "compact_boundary") {
      // The SDK reports a compaction once it has finished, so only the finished step is emitted.
      const { trigger, pre_tokens: tokensBefore, post_tokens: tokensAfter } = msg.compact_metadata ?? {};
      ctx.emit({ type: EventType.STEP_FINISHED, stepName: "compact", metadata: { aiCollab: { compaction: { trigger, phase: "finished", tokensBefore, tokensAfter } } } });
    } else if (msg.type === "rate_limit_event") {
      // sdk.d.ts:6224; only a rejected window is a limit (lib/limits.ts).
      const limit = classifyLimit("claude", { kind: "rate_limit_event", rate_limit_info: msg.rate_limit_info });
      if (limit) ctx.emit({ type: EventType.CUSTOM, name: LIMIT, value: limit, ...attribution });
    } else if (msg.type === "result") {
      finishRun(msg.is_error && !run?.cancelled ? { error: msg.errors?.join("; ") || msg.subtype } : {});
    }
  }

  // Owns the query's lifetime: a failed or exited process ends the open run with RUN_ERROR.
  (async () => {
    try {
      for await (const msg of q) onMessage(msg);
    } catch (error) {
      if (!closed) ctx.log(`claude query failed: ${error.message}`);
      if (!closed && run) finishRun({ error: `claude session failed: ${error.message}` });
    } finally {
      ended = true;
      if (!closed) {
        if (run) finishRun({ error: "claude process exited during a run" });
        cancelPending("cancelled");
        for (const watch of [...compactWatch]) watch({ type: "system", subtype: "status", compact_result: "failed", compact_error: "the claude process exited" });
      }
    }
  })();

  const handle = {
    nativeId,
    async send(input) {
      if (closed || ended) throw new Error("the claude session has ended");
      if (run) throw new Error("claude: a run is already running");
      const runId = randomUUID();
      run = { runId, cancelled: false };
      try {
        const message = await userMessage(input);
        ctx.emit({
          type: EventType.RUN_STARTED, threadId, runId,
          input: { threadId, runId, tools: [], context: [], messages: [{ id: `${runId}:input`, role: "user", content: input.text }] },
        });
        inputs.push(message);
      } catch (error) {
        run = null;
        throw error;
      }
      return { runId };
    },
    async steer(input) {
      if (!run) throw new Error("claude: no run to steer");
      inputs.push(await userMessage(input, "now"));
    },
    async interrupt() {
      if (!run) return;
      run.cancelled = true;
      cancelPending("cancelled");
      await q.interrupt();
    },
    async setModel(model) {
      if (closed || ended) throw new Error("the claude session has ended");
      if (run || compactWatch.size) throw new Error("claude: wait for the current operation to finish before switching models");
      await q.setModel(model);
    },
    // "/compact" typed into the session: the CLI runs its own compaction on the live conversation.
    // The CLI reports it with a compact_boundary (finished with token counts) and a status message.
    async compact() {
      if (closed || ended) throw new Error("the claude session has ended");
      if (run) throw new Error("claude: finish the running turn before compacting");
      if (compactWatch.size) throw new Error("claude: a compaction is already running");
      const boundary = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { stop(); reject(new Error("compaction timed out")); }, COMPACT_MS);
        function stop() { clearTimeout(timer); compactWatch.delete(watch); }
        const watch = (msg) => {
          if (msg.type === "system" && msg.subtype === "compact_boundary") {
            stop();
            const meta = msg.compact_metadata ?? {};
            return resolve({ before: meta.pre_tokens, after: meta.post_tokens });
          }
          if (msg.type === "system" && msg.subtype === "status" && msg.compact_result === "failed") {
            stop();
            reject(new Error(msg.compact_error || "claude compaction failed"));
          }
        };
        compactWatch.add(watch);
      });
      boundary.catch(() => {}); // rejected only if the watcher is abandoned
      // A local slash command bypasses the loop, so it carries no run; the answer arrives as local_command_output.
      inputs.push({ type: "user", message: { role: "user", content: "/compact" }, parent_tool_use_id: null });
      return boundary;
    },
    async respond(interruptId, decision) {
      respond(interruptId, decision);
    },
    async setPermissionMode(mode) {
      const { settings, error } = permissionSettings("claude", mode);
      if (error) throw new Error(error);
      await q.setPermissionMode(settings.permissionMode);
      ctx.emit({ type: EventType.STATE_DELTA, delta: [{ op: "replace", path: "/permissionMode", value: mode }] });
    },
    async contextUsage() {
      try {
        const usage = await q.getContextUsage();
        return { tokens: usage.totalTokens, window: usage.maxTokens };
      } catch {
        return null;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      if (run) finishRun({});
      cancelPending("cancelled");
      // An in-flight compact() fails at once instead of waiting for its timeout.
      for (const watch of [...compactWatch]) watch({ type: "system", subtype: "status", compact_result: "failed", compact_error: "the session closed" });
      inputs.end();
      q.close();
    },
  };
  return { handle, q };
}

/** Waits for the CLI handshake within handshakeMs, so a missing, unauthenticated or hung CLI fails at open or resume. */
async function attach(session, label, handshakeMs) {
  let timer;
  try {
    await Promise.race([
      session.q.initializationResult(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no response from the CLI within ${handshakeMs / 1000} s`)), handshakeMs);
      }),
    ]);
  } catch (error) {
    await session.handle.close();
    throw new Error(`${label} failed to start: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
  return session.handle;
}

/** Runs a query with no prompt, reads its initialization result, then closes it. */
async function probe(query, options, read) {
  const inputs = inputQueue();
  const q = query({ prompt: inputs, options });
  try {
    return read(await q.initializationResult());
  } finally {
    inputs.end();
    q.close();
  }
}

/**
 * The Claude adapter with an injected query function (tests pass a fake; the default export uses the SDK).
 * handshakeMs bounds the CLI handshake at open and resume.
 */
export function createClaudeAdapter({ query = sdkQuery, handshakeMs = HANDSHAKE_MS } = {}) {
  return {
    harness: "claude",
    capabilities: { steer: true, images: true, resume: "transcript", permissionModes: PERMISSION_MODES },
    async available(childVars) {
      const path = findExecutable("claude", childEnv(childVars).PATH);
      return path ? { ok: true, detail: path } : { ok: false, detail: "claude is not on PATH" };
    },
    // The session id is chosen here, so the native id is known before the first prompt.
    // options.beforeStart(nativeId) runs before the CLI child starts, so its owned record stands down the child's hooks.
    async open(options, ctx) {
      const nativeId = randomUUID();
      await options.beforeStart?.(nativeId);
      const session = startSession({
        query, ctx, nativeId, cwd: options.cwd, model: options.model, permission: options.permission, env: options.env, codeMode: options.codeMode,
      });
      return attach(session, "claude session", handshakeMs);
    },
    async resume(record, ctx, childVars) {
      // A /permission value is the SDK mode for this resume; without one the runner's mode for the record stands.
      const { settings: runnerSettings } = permissionSettings("claude", record.permissionMode, record.place);
      const settings = record.claudePermission ? { permissionMode: record.claudePermission } : runnerSettings;
      const session = startSession({
        query, ctx, nativeId: record.nativeId, cwd: record.cwd, model: record.model, permission: settings, env: childVars, resume: true, codeMode: record.codeMode,
      });
      return attach(session, "claude resume", handshakeMs);
    },
    async listModels(childVars) {
      return probe(query, { env: childEnv(childVars) }, (init) => init.models.map((m) => ({ id: m.value, label: m.displayName })));
    },
    async listCommands(cwd, childVars) {
      return probe(query, { cwd, env: childEnv(childVars) }, (init) => init.commands.map((c) => ({
        name: c.name, ...(c.description ? { description: c.description } : {}), ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
      })));
    },
    async shutdown() {},
  };
}

// The env arrives per call from the runner, so the factory takes no options.
export default function claudeAdapter() {
  return createClaudeAdapter();
}
