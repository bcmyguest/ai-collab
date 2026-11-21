// OpenCode 2 plugin: maps OpenCode hooks and events to scripts/ai-collab-hook.mjs --host opencode (README, OpenCode).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ID = "ai-collab";
export const HOOK_SCRIPT = fileURLToPath(new URL("../scripts/ai-collab-hook.mjs", import.meta.url));
// Same limits as the Claude registrations in hooks/hooks.json.
export const HOOK_TIMEOUT_MS = { SessionStart: 20_000, UserPromptSubmit: 10_000, PostToolUse: 10_000, PermissionRequest: 600_000, Stop: 660_000 };
export const ACTIVITY_TIMEOUT_MS = 5_000;
export const EVENT_TYPES = ["session.text.ended", "session.step.ended", "session.compaction.started", "session.deleted"];
const MAX_SESSIONS = 256;
const MAX_DEPTH = 8;
const OUTPUT_MAX = 1 << 20;
const RESOURCES_MAX = 20;

/** Runs the shared hook once with one JSON input; resolves its JSON output, or {} on any failure, timeout, or abort. */
export function runHook(input, { activity = false, timeoutMs = ACTIVITY_TIMEOUT_MS, signal, node = "node", script = HOOK_SCRIPT, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      const args = [script, ...(activity ? ["--activity"] : []), "--host", "opencode"];
      child = spawn(node, args, { env, cwd: typeof input.cwd === "string" ? input.cwd : undefined, stdio: ["pipe", "pipe", "ignore"], shell: false });
    } catch {
      return resolve({});
    }
    let out = "";
    // SIGTERM lets a waiting approval close its phone request before it exits.
    const stop = () => child.kill("SIGTERM");
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); };
    child.stdout.on("data", (chunk) => { if (out.length < OUTPUT_MAX) out += chunk; });
    child.on("error", () => { done(); resolve({}); });
    child.on("close", () => {
      done();
      try {
        const value = JSON.parse(out.trim().split("\n").pop() || "{}");
        resolve(value && typeof value === "object" && !Array.isArray(value) ? value : {});
      } catch {
        resolve({});
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

/** Context text a hook output asks to inject, or "". */
export function contextText(output) {
  const text = output?.hookSpecificOutput?.additionalContext ?? output?.additional_context;
  return typeof text === "string" ? text : "";
}

/** Appends text to a tool result in place; OpenCode takes a string or an array of content parts. */
export function appendContent(result, text) {
  if (!result || typeof result !== "object" || !text) return;
  const content = result.content;
  if (typeof content === "string") result.content = `${content}\n\n${text}`;
  else if (Array.isArray(content) && content.length) result.content = [...content, { type: "text", text }];
  else result.content = [{ type: "text", text: typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? "") }, { type: "text", text }];
}

/** A tool result for activity: its output, else its text parts. */
export function resultOutput(result) {
  if (result?.output !== undefined) return result.output;
  const content = result?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((p) => p?.type === "text").map((p) => p.text).join("\n") : "";
}

/** Context tokens of one finished step (input plus cache reads and writes), or undefined. */
export function stepTokens(tokens) {
  const parts = [tokens?.input, tokens?.cache?.read ?? 0, tokens?.cache?.write ?? 0];
  return parts.every((n) => Number.isSafeInteger(n) && n >= 0) ? parts.reduce((a, b) => a + b, 0) : undefined;
}

/** A permission request's resources as tool input: one resource as a command, several as a list. */
export function permissionInput(ev) {
  const resources = Array.isArray(ev?.resources) ? ev.resources.filter((r) => typeof r === "string").slice(0, RESOURCES_MAX) : [];
  return resources.length === 1 ? { command: resources[0] } : { resources };
}

function unwrap(value) {
  return value && typeof value === "object" && value.data && typeof value.data === "object" ? value.data : value;
}

/** The plugin object; run is injectable for tests. */
export function createPlugin({ run = runHook } = {}) {
  async function setup(ctx) {
    const directory = ctx?.location?.directory || process.cwd();
    const sessions = new Map();

    // Session facts (root, agent, title, folder), cached; a parent resolves before its child.
    async function resolve(id, depth = 0) {
      if (typeof id !== "string" || !id) return null;
      const known = sessions.get(id);
      if (known) return known.foreign ? null : known;
      let info = null;
      try { info = unwrap(await ctx.session.get({ sessionID: id })); } catch { /* unknown: a root */ }
      const parentID = typeof info?.parentID === "string" && info.parentID && depth < MAX_DEPTH ? info.parentID : "";
      const parent = parentID ? await resolve(parentID, depth + 1) : null;
      const entry = {
        id, root: parent ? parent.root : id, child: Boolean(parent), agent: typeof info?.agent === "string" ? info.agent : "",
        title: typeof info?.title === "string" ? info.title : "", cwd: info?.location?.directory || directory,
        started: false, continued: false, tokens: undefined, lastText: "", stopping: null,
      };
      // Each OpenCode location loads its own plugin instance; another folder's session belongs to that instance.
      entry.foreign = path.resolve(entry.cwd) !== path.resolve(directory);
      sessions.set(id, entry);
      while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      return entry.foreign ? null : entry;
    }

    // Claude-shaped hook input; a child session reports as an agent of its root.
    function input(s, event, extra = {}) {
      return {
        hook_event_name: event, session_id: s.root, cwd: s.cwd,
        ...(s.title && !s.child ? { session_title: s.title } : {}),
        ...(s.child ? { agent_id: s.id, agent_type: s.agent } : {}),
        ...extra,
      };
    }

    const tokens = (s) => (s.tokens !== undefined ? { context_tokens: s.tokens } : {});
    const activity = (s, event, extra) => { void Promise.resolve(run(input(s, event, extra), { activity: true })).catch(() => {}); };
    const call = (s, event, extra, options = {}) => Promise.resolve(run(input(s, event, extra), { timeoutMs: HOOK_TIMEOUT_MS[event], ...options })).catch(() => ({}));

    async function onPrompt(ev) {
      const s = await resolve(ev?.sessionID);
      if (!s) return;
      if (s.child) {
        if (!s.started) { s.started = true; activity(s, "SubagentStart"); }
        return;
      }
      // A prompt typed during an AFK hold ends the hold, like a prompt queued in Claude's terminal.
      s.stopping?.abort();
      const texts = [];
      if (!s.started) {
        s.started = true;
        texts.push(contextText(await call(s, "SessionStart", { source: "startup" })));
      }
      s.continued = false;
      const prompt = typeof ev.prompt?.text === "string" ? ev.prompt.text : "";
      texts.push(contextText(await call(s, "UserPromptSubmit", { prompt })));
      const extra = texts.filter(Boolean).join("\n");
      if (extra && ev.prompt && typeof ev.prompt === "object") ev.prompt.text = prompt ? `${prompt}\n\n${extra}` : extra;
    }

    async function onIdle(ev) {
      const s = await resolve(ev?.sessionID);
      if (!s) return;
      if (s.child) return activity(s, "SubagentStop", { last_assistant_message: s.lastText });
      const stopping = new AbortController();
      s.stopping = stopping;
      let out;
      try {
        out = await call(s, "Stop", { stop_hook_active: s.continued, ...tokens(s) }, { signal: stopping.signal });
      } finally {
        if (s.stopping === stopping) s.stopping = null;
      }
      const reason = !stopping.signal.aborted && out?.decision === "block" && typeof out.reason === "string" ? out.reason : "";
      s.continued = Boolean(reason);
      // OpenCode keeps the session running when input is waiting after this hook.
      if (reason) await ctx.session.synthetic({ sessionID: s.id, text: reason, description: "AI Collab", metadata: { source: PLUGIN_ID } });
    }

    async function onToolBefore(ev) {
      const s = await resolve(ev?.sessionID);
      if (s) activity(s, "PreToolUse", { tool_name: ev.tool, tool_input: ev.input, tool_use_id: ev.id });
    }

    async function onToolAfter(ev) {
      const s = await resolve(ev?.sessionID);
      if (!s) return;
      const base = { tool_name: ev.tool, tool_input: ev.input, tool_use_id: ev.id };
      if (ev.status === "error") {
        const error = ev.error?.message ?? ev.error;
        return activity(s, "PostToolUseFailure", { ...base, error: typeof error === "string" ? error : JSON.stringify(error ?? "tool failed") });
      }
      const extra = { ...base, tool_response: resultOutput(ev.result), ...tokens(s) };
      // A subagent's tool results only publish activity; messages reach the root session.
      if (s.child) return activity(s, "PostToolUse", extra);
      const text = contextText(await call(s, "PostToolUse", extra));
      if (text) appendContent(ev.result, text);
    }

    async function onPermission(ev) {
      if (ev?.effect !== "ask") return;
      const s = await resolve(ev.sessionID);
      if (!s) return;
      const out = await call(s, "PermissionRequest", { tool_name: String(ev.action || "permission"), tool_input: permissionInput(ev) });
      const decision = out?.hookSpecificOutput?.decision;
      if (decision?.behavior === "allow") ev.effect = "allow";
      else if (decision?.behavior === "deny") {
        ev.effect = "deny";
        if (typeof decision.message === "string") ev.message = decision.message;
      }
    }

    async function onEvent(event) {
      const where = event?.location?.directory;
      if (where && path.resolve(where) !== path.resolve(directory)) return;
      const data = event?.data || event?.properties || {};
      const s = event?.type === "session.deleted" ? sessions.get(data.sessionID) : await resolve(data.sessionID);
      if (!s || s.foreign) return;
      switch (event.type) {
        case "session.text.ended":
          if (typeof data.text === "string" && data.text.trim()) {
            s.lastText = data.text;
            activity(s, "AfterAgentResponse", { text: data.text });
          }
          break;
        case "session.step.ended":
          s.tokens = stepTokens(data.tokens) ?? s.tokens;
          break;
        case "session.compaction.started":
          activity(s, "PreCompact", { trigger: data.reason, ...tokens(s) });
          break;
        case "session.deleted":
          if (!s.child) activity(s, "SessionEnd", { reason: "deleted" });
          sessions.delete(s.id);
          break;
      }
    }

    const guard = (fn) => async (ev) => { try { await fn(ev); } catch { /* fail open */ } };
    const register = async (domain, name, fn) => {
      try { await ctx[domain]?.hook?.(name, guard(fn)); } catch { /* this release lacks the hook */ }
    };
    await register("session", "prompt", onPrompt);
    await register("session", "experimental.idle", onIdle);
    await register("tool", "execute.before", onToolBefore);
    await register("tool", "execute.after", onToolAfter);
    await register("permission", "evaluate", onPermission);

    const controller = new AbortController();
    if (typeof ctx?.event?.subscribe === "function") {
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ types: EVENT_TYPES, signal: controller.signal })) {
            if (EVENT_TYPES.includes(event?.type)) void guard(onEvent)(event);
          }
        } catch { /* the stream ended */ }
      })();
    }
    return () => controller.abort();
  }
  return { id: PLUGIN_ID, setup };
}

export default createPlugin();
