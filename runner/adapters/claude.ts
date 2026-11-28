// Claude adapter: one Agent SDK query() per owned session (docs/owned-sessions-contract.md, "Adapter interface").
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { EventType } from "@ag-ui/core";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { sessionLabel } from "../../lib/config.ts";
import { childEnv } from "../../lib/sessions/launch.ts";
import { findExecutable } from "../../lib/sessions/scope.ts";
import { classifyLimit } from "../../lib/limits.ts";
import { claudeCodeModeSettings } from "../../lib/code-mode.ts";
import { CLAUDE_SUBAGENT_TOOLS } from "../../lib/subagent-guard.ts";
import { APPROVAL_REQUESTED, APPROVAL_RESOLVED, LIMIT, PERMISSION_MODES, permissionSettings } from "../contract.ts";
import { CLAUDE_IN, claudeSpawner, createClaudeSandbox } from "./cli-sandbox.ts";
import type { CliBox, CliSandbox } from "./cli-sandbox.ts";

import type { Decision, SessionContext, UserInput } from "../types.d.ts";

// oxlint-disable-next-line typescript/no-explicit-any -- harness protocol frames, session records and runner requests are JSON
type Json = any;

// Env marker on the CLI child; hooks stand down by the owned record, this names the harness that spawned the child.
export const OWNED_ENV = "AI_COLLAB_OWNED";
const ASK_QUESTION = "AskUserQuestion";
const HANDSHAKE_MS = 60_000;
const COMPACT_MS = 5 * 60_000;

/** A push-based async iterable: the SDK reads user messages from it, and end() closes it. */
export function inputQueue() {
  const items: Json[] = [];
  let wake: Json = null;
  let ended = false;
  return {
    push(message: Json) { items.push(message); wake?.(); wake = null; },
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

const textOf = (content: Json) => (typeof content === "string" ? content
  : (Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : ""));

/** A one-line description of a tool call for the approval card. */
export function summarize(toolName: string, input: Json) {
  if (typeof input?.command === "string") return input.command;
  if (typeof input?.file_path === "string") return `${toolName} ${input.file_path}`;
  return `${toolName} ${JSON.stringify(input ?? {}).slice(0, 500)}`;
}

/** An SDKUserMessage carrying the input's text and images. */
async function userMessage(input: UserInput, priority?: Json) {
  const images = await Promise.all((input.images || []).map(async (image: Json) => ({
    type: "image",
    source: { type: "base64", media_type: image.mime, data: (await readFile(image.path)).toString("base64") },
  })));
  const content = images.length ? [...images, { type: "text", text: input.text }] : input.text;
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, ...(priority ? { priority } : {}) };
}

/** Starts one session's query and message pump; attach() awaits the handshake before the handle is used. */
function startSession({ query, ctx, nativeId, cwd, model, permission, env, resume, codeMode, managed, launch, allowFullAccess }: Json) {
  const threadId = `claude#${sessionLabel(nativeId)}`;
  const inputs = inputQueue();
  const pending = new Map();
  const toolNames = new Map();
  // Watchers for an in-flight compact(), fed every message before the run/approval branches.
  const compactWatch = new Set<(msg: Json) => void>();
  let run: Json = null;
  let closed = false;
  let ended = false;

  const q = query({
    prompt: inputs,
    options: {
      cwd,
      env: { ...env, [OWNED_ENV]: "claude", AI_COLLAB_PARENT: threadId },
      permissionMode: permission.permissionMode,
      // The SDK refuses a later setPermissionMode("bypassPermissions") unless the query opened with this.
      ...(allowFullAccess ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool: (toolName: string, input: UserInput, extra: Json) => canUseTool(toolName, input, extra),
      ...(model ? { model } : {}),
      // A managed session has no native subagents; ai-collab spawn_agent replaces them.
      ...(managed ? { disallowedTools: [...CLAUDE_SUBAGENT_TOOLS] } : {}),
      // Flag settings are the only layer a headless Claude reads code mode from (lib/code-mode.ts).
      ...(typeof codeMode === "boolean" ? { settings: claudeCodeModeSettings(codeMode) } : {}),
      ...(resume ? { resume: nativeId } : { sessionId: nativeId }),
      // An OpenShell session's CLI runs in its sandbox through this spawner (createClaudeAdapter's sandbox).
      ...(launch ?? {}),
    },
  });

  // Settles one approval: the SDK gets the decision, and the card gets its resolution event once.
  function settle(interruptId: string, decision: Json, value: Json) {
    const card = pending.get(interruptId);
    if (!card) return;
    pending.delete(interruptId);
    card.signal?.removeEventListener("abort", card.onAbort);
    ctx.emit({ type: EventType.CUSTOM, name: APPROVAL_RESOLVED, value: { interruptId, ...value } });
    card.resolve(decision);
  }

  function cancelPending(status: Json) {
    for (const interruptId of [...pending.keys()]) {
      settle(interruptId, { behavior: "deny", message: "the run was cancelled" }, { status, reason: "cancelled" });
    }
  }

  function finishRun({ error }: { error?: string }) {
    const finished = run;
    run = null;
    if (!finished) return;
    if (error) ctx.emit({ type: EventType.RUN_ERROR, message: error, metadata: { aiCollab: { runId: finished.runId } } });
    else ctx.emit({ type: EventType.RUN_FINISHED, threadId, runId: finished.runId, outcome: { type: finished.cancelled ? "cancelled" : "success" } });
  }

  function canUseTool(toolName: string, input: Json, { signal, toolUseID }: Json) {
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
  function respond(interruptId: string, decision: Decision) {
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

  function onMessage(msg: Json) {
    // A compaction in flight sees the boundary and status messages before anything else claims them.
    if (compactWatch.size) for (const watch of [...compactWatch]) watch(msg);
    const attribution = msg.parent_tool_use_id ? { subagentRunId: msg.parent_tool_use_id } : {};
    if (msg.type === "assistant") {
      msg.message.content.forEach((block: Json, index: Json) => {
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
  void (async () => {
    try {
      for await (const msg of q) onMessage(msg);
    } catch (error: Json) {
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
    async send(input: UserInput) {
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
      } catch (error: Json) {
        run = null;
        throw error;
      }
      return { runId };
    },
    async steer(input: UserInput) {
      if (!run) throw new Error("claude: no run to steer");
      inputs.push(await userMessage(input, "now"));
    },
    async interrupt() {
      if (!run) return;
      run.cancelled = true;
      cancelPending("cancelled");
      await q.interrupt();
    },
    async setModel(model: Json) {
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
        const watch = (msg: Json) => {
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
    async respond(interruptId: string, decision: Decision) {
      respond(interruptId, decision);
    },
    async setPermissionMode(mode: Json) {
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
async function attach(session: Json, label: string, handshakeMs: Json) {
  let timer;
  try {
    await Promise.race([
      session.q.initializationResult(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no response from the CLI within ${handshakeMs / 1000} s`)), handshakeMs);
      }),
    ]);
  } catch (error: Json) {
    await session.handle.close();
    throw new Error(`${label} failed to start: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
  return session.handle;
}

/** Runs a query with no prompt, reads its initialization result, then closes it. */
async function probe(query: Json, options: Json, read: Json) {
  const inputs = inputQueue();
  const q = query({ prompt: inputs, options });
  try {
    return read(await q.initializationResult());
  } finally {
    inputs.end();
    q.close();
  }
}

/** The handle with a close that waits for the sandboxed CLI, lands the work and releases the sandbox, and a syncBack for land finish. */
function boxedHandle(handle: Json, box: CliBox, stopped: () => Promise<void>, log: (line: string) => void) {
  let closed = false;
  return {
    ...handle,
    syncBack: () => box.syncBack(log),
    async close() {
      if (closed) return;
      closed = true;
      await handle.close();
      await stopped();
      await box.close(log);
    },
  };
}

/**
 * The Claude adapter with an injected query function (tests pass a fake; the default export uses the SDK).
 * handshakeMs bounds the CLI handshake at open and resume. `sandbox` runs place openshell sessions in the project's
 * Claude sandbox (cli-sandbox.ts); without one the adapter offers no openshell place.
 */
export function createClaudeAdapter({ query = sdkQuery, handshakeMs = HANDSHAKE_MS, sandbox = null }: { query?: Json; handshakeMs?: number; sandbox?: CliSandbox | null } = {}) {
  // Stages the sandbox and returns the query options that run the CLI there, with the box and a wait for the CLI's exit.
  async function openBox(project: string, cwd: string, vars: Json, ctx: SessionContext, resumeId: string | null) {
    if (!sandbox) throw new Error("claude has no OpenShell sandbox in this runner");
    const box = await sandbox.open({ project, cwd, home: vars?.HOME, log: ctx.log, ...(resumeId ? { id: resumeId, resume: true } : {}) });
    const { spawner, stopped } = claudeSpawner({ openshell: sandbox.openshell, env: vars ?? process.env, sandbox: box.name, workdir: box.workdir, log: ctx.log });
    return { box, stopped, launch: { spawnClaudeCodeProcess: spawner, pathToClaudeCodeExecutable: CLAUDE_IN, mcpServersDelivery: "initialize" } };
  }

  async function started(session: Json, label: string, boxed: Json, ctx: SessionContext) {
    if (!boxed) return attach(session, label, handshakeMs);
    try {
      return boxedHandle(await attach(session, label, handshakeMs), boxed.box, boxed.stopped, ctx.log);
    } catch (error) {
      await boxed.stopped();
      await boxed.box.close(ctx.log);
      throw error;
    }
  }

  return {
    harness: "claude",
    capabilities: { steer: true, images: true, resume: "transcript", permissionModes: PERMISSION_MODES, ...(sandbox ? { places: ["folder", "worktree", "openshell"], openshellTeams: false } : {}) },
    async available(childVars: Json) {
      const path = findExecutable("claude", childEnv(childVars).PATH);
      return path ? { ok: true, detail: path } : { ok: false, detail: "claude is not on PATH" };
    },
    // The session id is chosen here, so the native id is known before the first prompt.
    // options.beforeStart(nativeId) runs before the CLI child starts, so its owned record stands down the child's hooks.
    async open(options: Json, ctx: SessionContext) {
      const nativeId = randomUUID();
      await options.beforeStart?.(nativeId);
      const boxed = options.place === "openshell" ? await openBox(options.project, options.cwd, options.env, ctx, null) : null;
      const session = startSession({
        query, ctx, nativeId, cwd: boxed ? boxed.box.workdir : options.cwd, model: options.model, permission: options.permission, env: options.env, codeMode: options.codeMode, managed: options.managed === true, launch: boxed?.launch, allowFullAccess: options.allowFullAccess === true,
      });
      return started(session, "claude session", boxed, ctx);
    },
    async resume(record: Json, ctx: SessionContext, childVars: Json) {
      // A /permission value is the SDK mode for this resume; without one the runner's mode for the record stands.
      const { settings: runnerSettings } = permissionSettings("claude", record.permissionMode, record.place);
      const settings = record.claudePermission ? { permissionMode: record.claudePermission } : runnerSettings;
      // A restored record holds its sandbox claim under its address; the transcript stays in the sandbox's home.
      const boxed = record.place === "openshell" ? await openBox(record.project, record.cwd, childVars, ctx, record.address) : null;
      const session = startSession({
        query, ctx, nativeId: record.nativeId, cwd: boxed ? boxed.box.workdir : record.cwd, model: record.model, permission: settings, env: childVars, resume: true, codeMode: record.codeMode, managed: record.managed === true, launch: boxed?.launch, allowFullAccess: record.allowFullAccess === true,
      });
      return started(session, "claude resume", boxed, ctx);
    },
    async listModels(childVars: Json) {
      return probe(query, { env: childEnv(childVars) }, (init: Json) => init.models.map((m: Json) => ({ id: m.value, label: m.displayName })));
    },
    async listCommands(cwd: string, childVars: Json) {
      return probe(query, { cwd, env: childEnv(childVars) }, (init: Json) => init.commands.map((c: Json) => ({
        name: c.name, ...(c.description ? { description: c.description } : {}), ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
      })));
    },
    restore: (record: Json) => sandbox?.restore(record),
    release: (record: Json) => (sandbox ? sandbox.release(record) : Promise.resolve(true)),
    // Sandboxes outlive the runner, so their sessions resume after a restart.
    async shutdown() {},
  };
}

// The env arrives per call from the runner; the runner's env locates openshell and the CLI to upload.
export default function claudeAdapter({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}) {
  return createClaudeAdapter({ sandbox: createClaudeSandbox({ env }) });
}
