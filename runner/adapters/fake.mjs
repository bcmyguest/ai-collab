// Scripted in-process adapter for tests: "approve: <cmd>" asks for approval, "hang" runs until interrupted, else it echoes.
import { randomUUID } from "node:crypto";
import { EventType } from "@ag-ui/core";
import { sessionLabel } from "../../lib/config.ts";
import { APPROVAL_REQUESTED, PERMISSION_MODES } from "../contract.ts";

/** A fake Adapter; calls records every adapter call for assertions. */
export function createFakeAdapter({ harness = "codex", capabilities = {}, openError = null, compact = true } = {}) {
  const calls = [];
  let runs = 0;

  function makeHandle(nativeId, ctx) {
    const threadId = `${harness}#${sessionLabel(nativeId)}`;
    let running = null;
    const steered = [];

    async function run(runId, input, settled) {
      ctx.emit({
        type: EventType.RUN_STARTED, threadId, runId,
        input: { threadId, runId, tools: [], context: [], messages: [{ id: `${runId}:input`, role: "user", content: input.text }] },
      });
      await new Promise((resolve) => setImmediate(resolve));
      const approve = /approve: (.+)/.exec(input.text);
      let outcome = "success";
      if (approve) {
        const toolCallId = `c-${runId}`;
        ctx.emit({ type: EventType.TOOL_CALL_CHUNK, toolCallId, toolCallName: "Bash", delta: JSON.stringify({ command: approve[1] }, null, 2) });
        running.interruptId = `i-${runId}`;
        ctx.emit({
          type: EventType.CUSTOM, name: APPROVAL_REQUESTED,
          value: { interruptId: running.interruptId, reason: "tool_approval", toolCallId, toolCallName: "Bash", summary: approve[1] },
        });
        const answer = await settled;
        if (answer.interrupted) outcome = "cancelled";
        else {
          const failed = answer.behavior !== "allow";
          ctx.emit({
            type: EventType.TOOL_CALL_RESULT, toolCallId, messageId: `${toolCallId}:result`, role: "tool",
            content: failed ? "denied by the operator" : `ran ${approve[1]}`,
            metadata: { aiCollab: { toolCallName: "Bash", failed } },
          });
        }
      } else if (/\bhang\b/.test(input.text)) {
        if ((await settled).interrupted) outcome = "cancelled";
      }
      if (outcome === "success") ctx.emit({
        type: EventType.TEXT_MESSAGE_CHUNK, messageId: `m-${runId}`, role: "assistant", delta: `echo: ${input.text.slice(0, 200)}`,
      });
      running = null;
      ctx.emit({ type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: outcome } });
    }

    return {
      nativeId,
      steered,
      async send(input) {
        calls.push({ op: "send", nativeId, text: input.text });
        if (running) throw new Error("fake: a run is already running");
        const runId = `r${++runs}`;
        let release;
        const settled = new Promise((resolve) => { release = resolve; });
        running = { runId, release };
        setImmediate(() => run(runId, input, settled));
        return { runId };
      },
      async steer(input) {
        calls.push({ op: "steer", nativeId, text: input.text });
        steered.push(input.text);
      },
      async interrupt() {
        calls.push({ op: "interrupt", nativeId });
        running?.release({ interrupted: true });
      },
      async respond(interruptId, decision) {
        calls.push({ op: "respond", nativeId, interruptId, decision });
        if (running?.interruptId === interruptId) running.release(decision);
      },
      async setPermissionMode(mode) { calls.push({ op: "setPermissionMode", nativeId, mode }); },
      async contextUsage() { return { tokens: 1234, window: 200000 }; },
      // A harness "compaction": reports before/after counts and leaves a compact step in the timeline.
      ...(compact ? {
        async compact() {
          calls.push({ op: "compact", nativeId, running: Boolean(running) });
          if (running) throw new Error(`${harness}: finish the running turn before compacting`);
          ctx.emit({ type: EventType.STEP_FINISHED, stepName: "compact", metadata: { aiCollab: { compaction: { trigger: "manual", phase: "finished", tokensBefore: 90000, tokensAfter: 20000 } } } });
          return { before: 90000, after: 20000 };
        },
      } : {}),
      resumeData: () => ({ fake: true }),
      async close() {
        calls.push({ op: "close", nativeId });
        running?.release({ interrupted: true });
      },
    };
  }

  const adapter = {
    harness,
    calls,
    capabilities: { steer: true, images: false, resume: "transcript", permissionModes: PERMISSION_MODES, ...capabilities },
    async available() { return { ok: true }; },
    async open(options, ctx) {
      calls.push({ op: "open", options });
      if (openError) throw new Error(openError);
      return makeHandle(`fake-${randomUUID()}`, ctx);
    },
    async resume(record, ctx) {
      calls.push({ op: "resume", nativeId: record.nativeId, resume: record.resume });
      return makeHandle(record.nativeId, ctx);
    },
    async listModels() { return [{ id: "fake-1", default: true }]; },
    async listCommands(cwd) { return [{ name: "/fake", description: `in ${cwd}` }]; },
    async shutdown() { calls.push({ op: "shutdown" }); },
  };
  return adapter;
}
