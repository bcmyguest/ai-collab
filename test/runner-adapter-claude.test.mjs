// Claude adapter against a fake query(): no CLI or SDK runs, no tokens are spent.
import { EventType } from "@ag-ui/core";
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVAL_REQUESTED, APPROVAL_RESOLVED, eventProblem } from "../runner/contract.ts";
import { createClaudeAdapter } from "../runner/adapters/claude.mjs";
import { sessionLabel } from "../lib/config.ts";
import { tempDir } from "./helpers/tmp.mjs";

// A push-based async iterable standing in for the SDK's message stream.
function pushStream() {
  const items = [];
  let wake = null;
  let ended = false;
  return {
    push(item) { items.push(item); wake?.(); wake = null; },
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

// Records every query() call; onUser scripts the reply to each user message the adapter sends.
function fakeSdk({ onUser = echoReply, init, failInit = null, onCompact = compactReply } = {}) {
  const queries = [];
  const initResult = init ?? {
    models: [{ value: "default", displayName: "Default (recommended)", description: "x" }],
    commands: [{ name: "compact", description: "Compact the context", argumentHint: "" }, { name: "review", description: "", argumentHint: "<pr>" }],
  };
  function query({ prompt, options }) {
    const out = pushStream();
    const record = { prompt, options, closed: false, interrupts: 0, modes: [], seen: [], out, approvals: [] };
    const api = {
      emit: (message) => out.push(message),
      end: () => out.end(),
      result: (fields = {}) => out.push({ type: "result", subtype: "success", is_error: false, ...fields }),
      canUseTool: (...args) => options.canUseTool(...args),
    };
    record.api = api;
    queries.push(record);
    (async () => {
      for await (const message of prompt) {
        record.seen.push(message);
        // A local slash command bypasses the loop in the real CLI; the fake answers /compact the way the CLI does.
        const text = typeof message.message?.content === "string" ? message.message.content : "";
        if (text === "/compact") { await onCompact(api, record); continue; }
        await onUser(message, api, record);
      }
    })().catch((error) => out.end(error));
    record.q = {
      [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](),
      async initializationResult() {
        if (failInit) throw new Error(failInit);
        return initResult;
      },
      async interrupt() {
        record.interrupts++;
        api.result({});
      },
      async setModel(model) { record.model = model; },
      async setPermissionMode(mode) { record.modes.push(mode); },
      async getContextUsage() { return { totalTokens: 500, maxTokens: 200000 }; },
      close() { record.closed = true; out.end(); },
    };
    return record.q;
  }
  return { query, queries };
}

function echoReply(message, api) {
  const text = typeof message.message.content === "string" ? message.message.content : message.message.content.at(-1).text;
  api.emit({ type: "assistant", uuid: "a-1", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: `echo: ${text}` }] } });
  api.result({});
}

// What the CLI emits for a typed /compact: a status, the boundary with its token counts, then local output.
function compactReply(api) {
  api.emit({ type: "system", subtype: "status", status: "compacting", compact_result: undefined });
  api.emit({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 90000, post_tokens: 20000 } });
  api.emit({ type: "system", subtype: "local_command_output", content: "Compacted" });
}

function harness(sdk = fakeSdk(), extra = {}) {
  const events = [];
  const logs = [];
  const ctx = { emit: (e) => events.push(e), log: (m) => logs.push(m), signal: new AbortController().signal, ...extra };
  const adapter = createClaudeAdapter({ query: sdk.query });
  return { adapter, sdk, events, logs, ctx };
}

const OPTIONS = { project: "demo", cwd: "/tmp/demo", permissionMode: "auto", permission: { permissionMode: "auto" }, place: "folder", env: { PATH: "/usr/bin" } };

async function waitFor(predicate, ms = 2000) {
  const start = Date.now();
  for (;;) {
    const found = predicate();
    if (found) return found;
    if (Date.now() - start > ms) throw new Error("timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const isApproval = (e) => e.type === EventType.CUSTOM && e.name === APPROVAL_REQUESTED;
const isResolved = (e) => e.type === EventType.CUSTOM && e.name === APPROVAL_RESOLVED;
const finished = (e) => e.type === EventType.RUN_FINISHED;

test("Claude code-mode REPL calls and results reach the owned transcript", async (t) => {
  const { adapter, ctx, events } = harness(fakeSdk({
    onUser(_message, api) {
      api.emit({ type: "assistant", uuid: "assistant", message: { content: [
        { type: "tool_use", id: "repl-1", name: "REPL", input: { code: "console.log(17 * 19)" } },
      ] } });
      api.emit({ type: "user", message: { content: [
        { type: "tool_result", tool_use_id: "repl-1", content: "323" },
      ] } });
      api.result();
    },
  }));
  const handle = await adapter.open({ ...OPTIONS, codeMode: true }, ctx);
  t.after(() => handle.close());
  await handle.send({ text: "Compute 17*19 using the REPL" });
  await waitFor(() => events.find(finished));
  const call = events.find(e => e.type === EventType.TOOL_CALL_CHUNK);
  const result = events.find(e => e.type === EventType.TOOL_CALL_RESULT);
  assert.equal(call.toolCallName, "REPL");
  assert.equal(JSON.parse(call.delta).code, "console.log(17 * 19)");
  assert.equal(result.toolCallId, call.toolCallId);
  assert.equal(result.content, "323");
  assert.equal(eventProblem(call), null);
  assert.equal(eventProblem(result), null);
});

test("open chooses the native id, marks the child, and sends no prompt", async () => {
  const { adapter, sdk, events, ctx } = harness();
  const handle = await adapter.open(OPTIONS, ctx);
  const query = sdk.queries[0];
  assert.match(handle.nativeId, /^[0-9a-f-]{36}$/);
  assert.equal(query.options.sessionId, handle.nativeId);
  assert.equal(query.options.resume, undefined);
  assert.equal(query.options.permissionMode, "auto");
  assert.equal(query.options.cwd, "/tmp/demo");
  const label = sessionLabel(handle.nativeId);
  assert.equal(query.options.env.AI_COLLAB_OWNED, "claude");
  assert.equal(query.options.env.AI_COLLAB_PARENT, `claude#${label}`);
  assert.equal(query.options.env.PATH, "/usr/bin");
  assert.equal(query.seen.length, 0);
  assert.deepEqual(events, []);
  await handle.close();
});

test("send streams text as a run and emits valid AG-UI events", async () => {
  const { adapter, events, ctx } = harness();
  const handle = await adapter.open(OPTIONS, ctx);
  const { runId } = await handle.send({ text: "hello" });
  const done = await waitFor(() => events.find(finished));
  const label = sessionLabel(handle.nativeId);
  assert.equal(done.threadId, `claude#${label}`);
  assert.equal(done.runId, runId);
  assert.deepEqual(done.outcome, { type: "success" });
  const started = events.find((e) => e.type === EventType.RUN_STARTED);
  assert.equal(started.input.messages[0].content, "hello");
  const text = events.find((e) => e.type === EventType.TEXT_MESSAGE_CHUNK);
  assert.equal(text.delta, "echo: hello");
  assert.equal(text.role, "assistant");
  for (const e of events) assert.equal(eventProblem(e), null, JSON.stringify(e));
  await handle.close();
});

test("a second send while a run is open is rejected", async () => {
  const sdk = fakeSdk({ onUser: () => {} });
  const { adapter, ctx } = harness(sdk);
  const handle = await adapter.open(OPTIONS, ctx);
  await handle.send({ text: "one" });
  await assert.rejects(handle.send({ text: "two" }), /already running/);
  await handle.close();
});

test("a tool call asks for approval; allow runs the tool and reports its result", async () => {
  const sdk = fakeSdk({
    onUser: async (message, api, record) => {
      api.emit({ type: "assistant", uuid: "a-2", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] } });
      record.decision = await api.canUseTool("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "tu1" });
      if (record.decision.behavior === "allow") {
        api.emit({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "a.txt" }] } });
      }
      api.result({});
    },
  });
  const { adapter, events, ctx } = harness(sdk);
  const handle = await adapter.open(OPTIONS, ctx);
  await handle.send({ text: "list" });
  const card = await waitFor(() => events.find(isApproval));
  assert.equal(card.value.reason, "tool_approval");
  assert.equal(card.value.toolCallName, "Bash");
  assert.equal(card.value.summary, "ls");
  assert.equal(events.find((e) => e.type === EventType.TOOL_CALL_CHUNK).toolCallName, "Bash");
  await handle.respond(card.value.interruptId, { behavior: "allow" });
  await waitFor(() => events.find(finished));
  assert.equal(events.find(isResolved).value.reason, "allowed");
  const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT);
  assert.equal(result.toolCallId, "tu1");
  assert.equal(result.content, "a.txt");
  assert.equal(result.metadata.aiCollab.toolCallName, "Bash");
  assert.equal(result.metadata.aiCollab.failed, false);
  assert.deepEqual(sdk.queries[0].decision, { behavior: "allow", updatedInput: { command: "ls" } });
  for (const e of events) assert.equal(eventProblem(e), null, JSON.stringify(e));
  await handle.close();
});

test("deny returns a deny result to the SDK and reports the resolution", async () => {
  const sdk = fakeSdk({
    onUser: async (message, api, record) => {
      record.decision = await api.canUseTool("Bash", { command: "rm -rf /" }, { signal: new AbortController().signal, toolUseID: "tu2" });
      api.result({});
    },
  });
  const { adapter, events, ctx } = harness(sdk);
  const handle = await adapter.open(OPTIONS, ctx);
  await handle.send({ text: "go" });
  const card = await waitFor(() => events.find(isApproval));
  await handle.respond(card.value.interruptId, { behavior: "deny" });
  await waitFor(() => events.find(finished));
  assert.equal(events.find(isResolved).value.reason, "denied");
  assert.deepEqual(sdk.queries[0].decision, { behavior: "deny", message: "denied by the operator" });
  await handle.close();
});

test("AskUserQuestion becomes a question card and returns the answers", async () => {
  const questions = [{ question: "Which?", options: [{ label: "a" }, { label: "b" }] }];
  const sdk = fakeSdk({
    onUser: async (message, api, record) => {
      record.decision = await api.canUseTool("AskUserQuestion", { questions }, { signal: new AbortController().signal, toolUseID: "tq" });
      api.result({});
    },
  });
  const { adapter, events, ctx } = harness(sdk);
  const handle = await adapter.open(OPTIONS, ctx);
  await handle.send({ text: "ask" });
  const card = await waitFor(() => events.find(isApproval));
  assert.equal(card.value.reason, "question");
  assert.deepEqual(card.value.questions, questions);
  await handle.respond(card.value.interruptId, { behavior: "allow", answers: { Which: "a" } });
  await waitFor(() => events.find(finished));
  assert.equal(events.find(isResolved).value.reason, "answered");
  assert.deepEqual(sdk.queries[0].decision.updatedInput, { questions, answers: { Which: "a" } });
  await handle.close();
});

test("interrupt ends the run as cancelled and cancels its pending approval", async () => {
  const sdk = fakeSdk({
    onUser: (message, api, record) => {
      record.pending = api.canUseTool("Bash", { command: "sleep 9" }, { signal: new AbortController().signal, toolUseID: "tu3" });
    },
  });
  const { adapter, events, ctx } = harness(sdk);
  const handle = await adapter.open(OPTIONS, ctx);
  await handle.send({ text: "wait" });
  await waitFor(() => events.find(isApproval));
  await handle.interrupt();
  const done = await waitFor(() => events.find(finished));
  assert.deepEqual(done.outcome, { type: "cancelled" });
  assert.equal(events.find(isResolved).value.reason, "cancelled");
  assert.equal(sdk.queries[0].interrupts, 1);
  assert.deepEqual(await sdk.queries[0].pending, { behavior: "deny", message: "the run was cancelled" });
  await handle.close();
});

test("an error result ends the run with RUN_ERROR carrying the runId", async () => {
  const sdk = fakeSdk({ onUser: (message, api) => api.result({ subtype: "error_during_execution", is_error: true, errors: ["boom"] }) });
  const { adapter, events, ctx } = harness(sdk);
  const handle = await adapter.open(OPTIONS, ctx);
  const { runId } = await handle.send({ text: "x" });
  const error = await waitFor(() => events.find((e) => e.type === EventType.RUN_ERROR));
  assert.equal(error.message, "boom");
  assert.equal(error.metadata.aiCollab.runId, runId);
  assert.equal(eventProblem(error), null);
  await handle.close();
});

test("a process that exits mid-run ends it with RUN_ERROR", async () => {
  const sdk = fakeSdk({ onUser: () => {} });
  const { adapter, events, ctx } = harness(sdk);
  const handle = await adapter.open(OPTIONS, ctx);
  const { runId } = await handle.send({ text: "x" });
  sdk.queries[0].api.end();
  const error = await waitFor(() => events.find((e) => e.type === EventType.RUN_ERROR));
  assert.equal(error.message, "claude process exited during a run");
  assert.equal(error.metadata.aiCollab.runId, runId);
  await assert.rejects(handle.send({ text: "again" }), /has ended/);
});

test("steer queues an urgent message on the running query", async () => {
  const sdk = fakeSdk({ onUser: () => {} });
  const { adapter, ctx } = harness(sdk);
  const handle = await adapter.open(OPTIONS, ctx);
  await assert.rejects(handle.steer({ text: "early" }), /no run to steer/);
  await handle.send({ text: "first" });
  await handle.steer({ text: "now please" });
  const seen = await waitFor(() => (sdk.queries[0].seen.length === 2 ? sdk.queries[0].seen : null));
  assert.equal(seen[1].priority, "now");
  assert.equal(seen[1].message.content, "now please");
  await handle.close();
});

test("images are sent as base64 blocks before the text", async (t) => {
  const dir = tempDir(t, "claude-adapter-");
  const path = join(dir, "pic.png");
  writeFileSync(path, Buffer.from("PNGDATA"));
  const { adapter, sdk, ctx } = harness();
  const handle = await adapter.open(OPTIONS, ctx);
  await handle.send({ text: "look", images: [{ path, mime: "image/png" }] });
  const message = await waitFor(() => sdk.queries[0].seen[0]);
  assert.deepEqual(message.message.content[0], { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("PNGDATA").toString("base64") } });
  assert.deepEqual(message.message.content[1], { type: "text", text: "look" });
  await handle.close();
});

test("assistant output from a subagent carries its subagentRunId", async () => {
  const sdk = fakeSdk({
    onUser: (message, api) => {
      api.emit({ type: "assistant", uuid: "s-1", parent_tool_use_id: "toolu_9", message: { role: "assistant", content: [{ type: "text", text: "sub" }] } });
      api.result({});
    },
  });
  const { adapter, events, ctx } = harness(sdk);
  const handle = await adapter.open(OPTIONS, ctx);
  await handle.send({ text: "go" });
  await waitFor(() => events.find(finished));
  assert.equal(events.find((e) => e.type === EventType.TEXT_MESSAGE_CHUNK).subagentRunId, "toolu_9");
  await handle.close();
});

test("setPermissionMode maps the mode through the table and reports it", async () => {
  const { adapter, sdk, events, ctx } = harness();
  const handle = await adapter.open(OPTIONS, ctx);
  await handle.setPermissionMode("full-access");
  await handle.setPermissionMode("supervised");
  assert.deepEqual(sdk.queries[0].modes, ["bypassPermissions", "default"]);
  const state = events.find((e) => e.type === EventType.STATE_DELTA);
  assert.deepEqual(state.delta, [{ op: "replace", path: "/permissionMode", value: "full-access" }]);
  await handle.close();
});

test("resume reattaches by native id and maps the record's mode", async () => {
  const sdk = fakeSdk();
  const { adapter, ctx } = harness(sdk);
  const record = { nativeId: "11111111-2222-4333-8444-555555555555", cwd: "/tmp/demo", permissionMode: "supervised", place: "folder", model: "opus" };
  const handle = await adapter.resume(record, ctx, { PATH: "/usr/bin" });
  const query = sdk.queries[0];
  assert.equal(handle.nativeId, record.nativeId);
  assert.equal(query.options.resume, record.nativeId);
  assert.equal(query.options.sessionId, undefined);
  assert.equal(query.options.permissionMode, "default");
  assert.equal(query.options.model, "opus");
  assert.equal(query.options.env.AI_COLLAB_PARENT, `claude#${sessionLabel(record.nativeId)}`);
  await handle.close();
});

test("a failed handshake rejects open with an actionable message and closes the query", async () => {
  const sdk = fakeSdk({ failInit: "Claude Code is not logged in" });
  const { adapter, ctx } = harness(sdk);
  await assert.rejects(adapter.open(OPTIONS, ctx), /claude session failed to start: Claude Code is not logged in/);
  assert.equal(sdk.queries[0].closed, true);
});

test("close ends the prompt stream and the query, and a second close is a no-op", async () => {
  const { adapter, sdk, ctx } = harness();
  const handle = await adapter.open(OPTIONS, ctx);
  await handle.close();
  await handle.close();
  assert.equal(sdk.queries[0].closed, true);
  assert.equal(sdk.queries[0].interrupts, 0);
});

test("contextUsage maps the SDK totals", async () => {
  const { adapter, ctx } = harness();
  const handle = await adapter.open(OPTIONS, ctx);
  assert.deepEqual(await handle.contextUsage(), { tokens: 500, window: 200000 });
  await handle.close();
});

test("compact types /compact into the live query and reports the boundary's token counts", async () => {
  const { adapter, sdk, events, ctx } = harness();
  const handle = await adapter.open(OPTIONS, ctx);
  assert.equal(typeof handle.compact, "function");
  assert.deepEqual(await handle.compact(), { before: 90000, after: 20000 });
  const sent = sdk.queries[0].seen;
  assert.equal(sent.length, 1, "one message reached the CLI");
  assert.equal(sent[0].message.content, "/compact");
  assert.equal(sent[0].type, "user");
  // The finished boundary reaches the timeline as the compact step, and never opens a RUN.
  assert.ok(events.some((e) => e.type === EventType.STEP_FINISHED && e.stepName === "compact" && e.metadata.aiCollab.compaction.tokensAfter === 20000));
  assert.equal(events.filter((e) => e.type === EventType.RUN_STARTED).length, 0);
  await handle.close();
});

test("compact reports a failed compaction", async () => {
  const failing = fakeSdk({ onCompact: (api) => api.emit({ type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "context compaction failed" }) });
  const { adapter, ctx } = harness(failing);
  const handle = await adapter.open(OPTIONS, ctx);
  await assert.rejects(() => handle.compact(), /context compaction failed/);
  await handle.close();
});

test("compact refuses while a run is open, since /compact would land mid-turn", async () => {
  // A turn that stays open: no result until the test interrupts it.
  const sdk = fakeSdk({ onUser: (message, api) => api.emit({ type: "assistant", uuid: "a-1", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: "working" }] } }) });
  const { adapter, events, ctx } = harness(sdk);
  const handle = await adapter.open(OPTIONS, ctx);
  handle.send({ text: "work" });
  await waitFor(() => events.some((e) => e.type === EventType.RUN_STARTED));
  await assert.rejects(() => handle.compact(), /finish the running turn/);
  await handle.interrupt();
  await handle.close();
});

test("listModels and listCommands read initialization and close the probe query", async () => {
  const sdk = fakeSdk();
  const { adapter } = harness(sdk);
  assert.deepEqual(await adapter.listModels({ PATH: "/usr/bin" }), [{ id: "default", label: "Default (recommended)" }]);
  assert.deepEqual(await adapter.listCommands("/tmp/demo", { PATH: "/usr/bin" }), [
    { name: "compact", description: "Compact the context" },
    { name: "review", argumentHint: "<pr>" },
  ]);
  assert.equal(sdk.queries.every((q) => q.closed), true);
  assert.equal(sdk.queries[1].options.cwd, "/tmp/demo");
});

test("available reports the claude binary on PATH without running it", async (t) => {
  const { adapter } = harness();
  const dir = tempDir(t, "claude-bin-");
  writeFileSync(join(dir, "claude"), "#!/bin/sh\nexit 99\n");
  chmodSync(join(dir, "claude"), 0o755);
  // childEnv appends the Node bin dir, which may hold a real claude; the PATH entry given here comes first.
  assert.deepEqual(await adapter.available({ PATH: dir }), { ok: true, detail: join(dir, "claude") });
});

test("capabilities declare the transcript resume and every permission mode", () => {
  const { adapter } = harness();
  assert.equal(adapter.harness, "claude");
  assert.equal(adapter.capabilities.resume, "transcript");
  assert.deepEqual(adapter.capabilities.permissionModes, ["supervised", "accept-edits", "auto", "full-access"]);
});

test("model switching uses the existing streaming query", async () => {
  const { adapter, sdk, ctx } = harness();
  const handle = await adapter.open(OPTIONS, ctx);
  try {
    await handle.setModel("sonnet");
    assert.equal(sdk.queries.length, 1);
    assert.equal(sdk.queries[0].model, "sonnet");
    assert.deepEqual(sdk.queries[0].seen, []);
  } finally {
    await handle.close();
  }
});
