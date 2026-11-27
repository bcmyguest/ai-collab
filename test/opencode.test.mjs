import { parseWireEnvelope } from "../lib/agui.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig } from "../lib/config.mjs";
import { sendMessage } from "../lib/inbox.mjs";
import { activityEvents, buildActivity } from "../lib/activity.ts";
import { approvalOutput, approvalRequest } from "../lib/approvals.mjs";
import { contextTokens } from "../lib/usage.mjs";
import { sessionName } from "../lib/sessions/registry.ts";
import { appendContent, createPlugin, permissionInput, resultOutput, runHook, stepTokens } from "../lib/opencode-plugin.mjs";

const DIR = "/work/verify-opencode";
const ROOT = "ses_0123456789abcdefABCDEFghij";
const CHILD = "ses_9876543210zyxwvuZYXWVUtsrq";

// An event stream the test pushes into, ended by the plugin's abort signal.
function channel() {
  const queue = [];
  let wake = null;
  return {
    push(event) { queue.push(event); wake?.(); },
    async *subscribe({ signal } = {}) {
      while (!signal?.aborted) {
        if (queue.length) { yield queue.shift(); continue; }
        await new Promise((resolve) => { wake = resolve; signal?.addEventListener("abort", resolve, { once: true }); });
        wake = null;
      }
    },
  };
}

// A fake OpenCode 2 plugin context with the hook, session, and event surfaces the plugin uses.
function fakeCtx({ sessions = {}, directory = DIR } = {}) {
  const hooks = {};
  const synthetic = [];
  const events = channel();
  const hook = (domain) => async (name, fn) => { hooks[`${domain}:${name}`] = fn; return { dispose: async () => {} }; };
  const ctx = {
    location: { directory, project: { directory } },
    session: {
      hook: hook("session"),
      get: async ({ sessionID }) => sessions[sessionID] ?? { id: sessionID, location: { directory } },
      synthetic: async (input) => { synthetic.push(input); return { id: "inp_1" }; },
    },
    tool: { hook: hook("tool") },
    permission: { hook: hook("permission") },
    event: { subscribe: (options) => events.subscribe(options) },
  };
  return { ctx, hooks, synthetic, events };
}

// A recording stand-in for runHook; answer(input, options) gives each hook's output.
function recorder(answer = () => ({})) {
  const calls = [];
  const run = async (input, options = {}) => {
    calls.push({ input, options });
    return answer(input, options);
  };
  return { calls, run };
}

async function loaded(options = {}, answer) {
  const rec = recorder(answer);
  const fake = fakeCtx(options);
  const dispose = await createPlugin({ run: rec.run }).setup(fake.ctx);
  return { ...fake, ...rec, dispose };
}

test("opencode plugin registers the prompt, idle, tool, and permission hooks", async () => {
  const { hooks, dispose } = await loaded();
  assert.deepEqual(Object.keys(hooks).sort(), [
    "permission:evaluate", "session:experimental.idle", "session:prompt", "tool:execute.after", "tool:execute.before",
  ]);
  dispose();
});

test("opencode first prompt runs SessionStart then UserPromptSubmit and appends their context to the prompt", async () => {
  const { hooks, calls, dispose } = await loaded({ sessions: { [ROOT]: { id: ROOT, title: "Fix the build", location: { directory: DIR } } } },
    (input) => ({ hookSpecificOutput: { additionalContext: `[ai-collab] ${input.hook_event_name}` } }));
  const ev = { sessionID: ROOT, prompt: { text: "hello" } };
  await hooks["session:prompt"](ev);
  assert.deepEqual(calls.map((c) => c.input.hook_event_name), ["SessionStart", "UserPromptSubmit"]);
  assert.equal(calls[0].input.session_id, ROOT);
  assert.equal(calls[0].input.cwd, DIR);
  assert.equal(calls[0].input.session_title, "Fix the build");
  assert.equal(calls[1].input.prompt, "hello");
  assert.equal(calls[0].options.timeoutMs, 20_000);
  assert.equal(ev.prompt.text, "hello\n\n[ai-collab] SessionStart\n[ai-collab] UserPromptSubmit");
  await hooks["session:prompt"]({ sessionID: ROOT, prompt: { text: "again" } });
  assert.deepEqual(calls.slice(2).map((c) => c.input.hook_event_name), ["UserPromptSubmit"], "SessionStart runs once per session");
  dispose();
});

test("opencode idle runs Stop; a block reason continues the session through a synthetic input", async () => {
  let reply = { decision: "block", reason: "[ai-collab] 1 new peer message(s)." };
  const { hooks, calls, synthetic, dispose } = await loaded({}, (input) => (input.hook_event_name === "Stop" ? reply : {}));
  await hooks["session:experimental.idle"]({ sessionID: ROOT, background: false });
  assert.equal(calls[0].input.hook_event_name, "Stop");
  assert.equal(calls[0].input.stop_hook_active, false);
  assert.equal(calls[0].options.timeoutMs, 660_000);
  assert.deepEqual(synthetic, [{ sessionID: ROOT, text: reply.reason, description: "AI Collab", metadata: { source: "ai-collab" } }]);
  reply = {};
  await hooks["session:experimental.idle"]({ sessionID: ROOT });
  assert.equal(calls[1].input.stop_hook_active, true, "the Stop after a continuation is marked active");
  assert.equal(synthetic.length, 1, "no reason, no continuation");
  await hooks["session:experimental.idle"]({ sessionID: ROOT });
  assert.equal(calls[2].input.stop_hook_active, false);
  dispose();
});

test("opencode prompt during an AFK hold aborts the Stop hook and adds no continuation", async () => {
  let release;
  const { hooks, calls, synthetic, dispose } = await loaded({}, (input, options) => {
    if (input.hook_event_name !== "Stop") return {};
    return new Promise((resolve) => {
      release = () => resolve({ decision: "block", reason: "[ai-collab] AFK mode is ON" });
      options.signal.addEventListener("abort", () => resolve({}), { once: true });
    });
  });
  const idle = hooks["session:experimental.idle"]({ sessionID: ROOT });
  await tick();
  const stop = calls.find((c) => c.input.hook_event_name === "Stop");
  assert.ok(stop.options.signal, "the Stop call is abortable");
  await hooks["session:prompt"]({ sessionID: ROOT, prompt: { text: "I'm back" } });
  assert.equal(stop.options.signal.aborted, true);
  release();
  await idle;
  assert.equal(synthetic.length, 0);
  dispose();
});

test("opencode tool hooks: call as activity, result delivers context into the tool output, failure as activity", async () => {
  const { hooks, calls, dispose } = await loaded({}, (input) => (input.hook_event_name === "PostToolUse" ? { hookSpecificOutput: { additionalContext: "[ai-collab] message" } } : {}));
  await hooks["tool:execute.before"]({ tool: "bash", sessionID: ROOT, id: "call_1", input: { command: "ls" } });
  assert.deepEqual(calls[0].input, { hook_event_name: "PreToolUse", session_id: ROOT, cwd: DIR, tool_name: "bash", tool_input: { command: "ls" }, tool_use_id: "call_1" });
  assert.equal(calls[0].options.activity, true);
  assert.equal(calls[1].options.gate, true, "the read gate runs before the tool");
  const after = { tool: "bash", sessionID: ROOT, id: "call_1", input: { command: "ls" }, status: "completed", result: { output: "a\nb", content: [{ type: "text", text: "a\nb" }] } };
  await hooks["tool:execute.after"](after);
  assert.equal(calls[2].input.hook_event_name, "PostToolUse");
  assert.equal(calls[2].input.tool_response, "a\nb");
  assert.equal(calls[2].options.activity, undefined, "PostToolUse delivers");
  assert.deepEqual(after.result.content, [{ type: "text", text: "a\nb" }, { type: "text", text: "[ai-collab] message" }]);
  await hooks["tool:execute.after"]({ tool: "bash", sessionID: ROOT, id: "call_2", input: {}, status: "error", error: { message: "exit 1" } });
  assert.deepEqual([calls[3].input.hook_event_name, calls[3].input.error, calls[3].options.activity], ["PostToolUseFailure", "exit 1", true]);
  dispose();
});

test("opencode execute.before throws the run_code recipe when the read gate denies", async () => {
  const recipe = "Call task_list through run_code (ai-collab-code server).";
  const { hooks, dispose } = await loaded({}, (input, options) => options.gate
    ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: recipe } }
    : {});
  await assert.rejects(
    () => hooks["tool:execute.before"]({ tool: "read", sessionID: ROOT, id: "call_r", input: { file_path: "/home/b/.local/share/ai-collab/tasks/a.json" } }),
    (error) => error.storeRead === true && error.message === recipe,
  );
  dispose();
});

test("opencode permission evaluate asks the phone only for ask; allow and deny set the effect", async () => {
  let behavior = "allow";
  const { hooks, calls, dispose } = await loaded({}, () => ({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior, ...(behavior === "deny" ? { message: "denied" } : {}) } } }));
  const allowed = { sessionID: ROOT, action: "bash", resources: ["git push"], effect: "allow" };
  await hooks["permission:evaluate"](allowed);
  assert.equal(calls.length, 0, "an allowed request never asks");
  const ask = { sessionID: ROOT, action: "bash", resources: ["git push"], effect: "ask" };
  await hooks["permission:evaluate"](ask);
  assert.deepEqual(calls[0].input, { hook_event_name: "PermissionRequest", session_id: ROOT, cwd: DIR, tool_name: "bash", tool_input: { command: "git push" } });
  assert.equal(calls[0].options.timeoutMs, 600_000);
  assert.equal(ask.effect, "allow");
  behavior = "deny";
  const denied = { sessionID: ROOT, action: "edit", resources: ["a.js", "b.js"], effect: "ask" };
  await hooks["permission:evaluate"](denied);
  assert.deepEqual(calls[1].input.tool_input, { resources: ["a.js", "b.js"] });
  assert.equal(denied.effect, "deny");
  assert.equal(denied.message, "denied");
  behavior = "none";
  const open = { sessionID: ROOT, action: "bash", resources: ["rm x"], effect: "ask" };
  await hooks["permission:evaluate"](open);
  assert.equal(open.effect, "ask", "no decision leaves OpenCode's own prompt");
  dispose();
});

test("opencode child session reports as a subagent of its root and gets no delivery or Stop hold", async () => {
  const sessions = {
    [ROOT]: { id: ROOT, location: { directory: DIR } },
    [CHILD]: { id: CHILD, parentID: ROOT, agent: "explore", location: { directory: DIR } },
  };
  const { hooks, calls, events, synthetic, dispose } = await loaded({ sessions }, () => ({ decision: "block", reason: "x", hookSpecificOutput: { additionalContext: "y" } }));
  const prompt = { sessionID: CHILD, prompt: { text: "find files" } };
  await hooks["session:prompt"](prompt);
  assert.equal(prompt.prompt.text, "find files", "a subagent prompt is not changed");
  assert.deepEqual(calls[0].input, { hook_event_name: "SubagentStart", session_id: ROOT, cwd: DIR, agent_id: CHILD, agent_type: "explore" });
  const after = { tool: "read", sessionID: CHILD, id: "c", input: {}, status: "completed", result: { output: "text", content: "text" } };
  await hooks["tool:execute.after"](after);
  assert.equal(calls[1].options.activity, true);
  assert.equal(after.result.content, "text");
  events.push({ type: "session.text.ended", location: { directory: DIR }, data: { sessionID: CHILD, text: "found 3 files" } });
  await tick(); await tick();
  assert.equal(calls[2].input.hook_event_name, "AfterAgentResponse");
  assert.equal(calls[2].input.agent_id, CHILD);
  await hooks["session:experimental.idle"]({ sessionID: CHILD });
  assert.deepEqual([calls[3].input.hook_event_name, calls[3].input.last_assistant_message, calls[3].options.activity], ["SubagentStop", "found 3 files", true]);
  assert.equal(synthetic.length, 0);
  dispose();
});

test("opencode events: text, step tokens, compaction, deletion; other folders' events and sessions are ignored", async () => {
  const sessions = { ses_otherfolder0123456789abcd: { id: "ses_otherfolder0123456789abcd", location: { directory: "/elsewhere" } } };
  const { hooks, calls, events, dispose } = await loaded({ sessions });
  events.push({ type: "session.text.ended", location: { directory: "/elsewhere" }, data: { sessionID: ROOT, text: "not ours" } });
  events.push({ type: "session.text.ended", location: { directory: DIR }, data: { sessionID: ROOT, text: "Done." } });
  events.push({ type: "session.step.ended", location: { directory: DIR }, data: { sessionID: ROOT, tokens: { input: 1000, output: 5, cache: { read: 200, write: 30 } } } });
  events.push({ type: "session.compaction.started", location: { directory: DIR }, data: { sessionID: ROOT, reason: "manual" } });
  events.push({ type: "session.deleted", location: { directory: DIR }, data: { sessionID: ROOT } });
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(calls.map((c) => c.input.hook_event_name), ["AfterAgentResponse", "PreCompact", "SessionEnd"]);
  assert.equal(calls[0].input.text, "Done.");
  assert.deepEqual([calls[1].input.trigger, calls[1].input.context_tokens], ["manual", 1230]);
  await hooks["session:prompt"]({ sessionID: "ses_otherfolder0123456789abcd", prompt: { text: "x" } });
  assert.equal(calls.length, 3, "another folder's session is left to its own plugin instance");
  dispose();
});

test("opencode helpers: content append, result text, tokens, permission input", () => {
  const a = { content: "out" };
  appendContent(a, "ctx");
  assert.equal(a.content, "out\n\nctx");
  const b = { output: { ok: 1 }, content: [] };
  appendContent(b, "ctx");
  assert.deepEqual(b.content, [{ type: "text", text: '{"ok":1}' }, { type: "text", text: "ctx" }]);
  assert.equal(resultOutput({ content: [{ type: "text", text: "x" }, { type: "image" }] }), "x");
  assert.equal(stepTokens({ input: 1, cache: { read: 2, write: 3 } }), 6);
  assert.equal(stepTokens({ input: -1 }), undefined);
  assert.deepEqual(permissionInput({ resources: ["a", 7] }), { command: "a" });
});

test("opencode shared code: activity harness, text events, approvals in Claude's shape, context tokens, title", () => {
  const cfg = { peer: "opencode", session: "0123456789abcdef" };
  assert.equal(parseWireEnvelope(buildActivity(cfg, "opencode", { type: "text", output: "hi" }).message).harness, "opencode");
  assert.deepEqual(activityEvents("opencode", "afteragentresponse", { text: "hi" }), [{ type: "text", output: "hi" }]);
  assert.deepEqual(activityEvents("opencode", "pretooluse", { tool_name: "bash", tool_input: { command: "ls" }, tool_use_id: "c" }),
    [{ type: "tool_call", tool: "bash", input: { command: "ls" }, callId: "c" }]);
  const req = approvalRequest("opencode", "permissionrequest", { tool_name: "bash", tool_input: { command: "git push" } });
  assert.equal(req.summary, "git push");
  assert.deepEqual(approvalOutput("opencode", { behavior: "allow" }, req), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  assert.equal(contextTokens("opencode", { context_tokens: 1234 }), 1234);
  assert.equal(sessionName("opencode", { session_title: "Fix\nthe build" }), "Fix the build");
});

test("opencode runHook against the real hook: SessionStart publishes status and returns the inbox", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "opencode", AI_COLLAB_PEERS: "opencode,bob" });
  await sendMessage(loadConfig({ ...env, AI_COLLAB_PEER: "bob" }), "opencode", "ping from bob");
  const cwd = mkdtempSync(join(tmpdir(), "verify-opencode-"));
  const out = await runHook({ hook_event_name: "SessionStart", session_id: ROOT, cwd, source: "startup" }, { env, node: process.execPath, timeoutMs: 15_000 });
  assert.match(out.hookSpecificOutput.additionalContext, /body="ping from bob"/);
  assert.match(out.hookSpecificOutput.additionalContext, /Your sender identity is opencode#/);
  const status = parseWireEnvelope(fake.state.publishes.find((p) => p.topic === "ai-collab-demo--status").message);
  assert.deepEqual([status.event, status.harness], ["start", "opencode"]);
});

test("opencode runHook: Stop with a waiting message blocks with it; a missing node resolves {}", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "opencode", AI_COLLAB_PEERS: "opencode,bob" });
  const cwd = mkdtempSync(join(tmpdir(), "verify-opencode-"));
  mkdirSync(cwd, { recursive: true });
  await sendMessage(loadConfig({ ...env, AI_COLLAB_PEER: "bob" }), "opencode", "late news");
  const out = await runHook({ hook_event_name: "Stop", session_id: ROOT, cwd, stop_hook_active: false }, { env, node: process.execPath, timeoutMs: 15_000 });
  assert.equal(out.decision, "block");
  assert.match(out.reason, /body="late news"/);
  assert.deepEqual(await runHook({ hook_event_name: "Stop", cwd }, { env, node: join(cwd, "no-node") }), {});
});
