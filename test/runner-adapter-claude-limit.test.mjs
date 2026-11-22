import assert from "node:assert/strict";
import { test } from "node:test";
import { EventType } from "@ag-ui/core";
import { createClaudeAdapter } from "../runner/adapters/claude.mjs";
import { LIMIT, eventProblem } from "../runner/contract.mjs";

// Minimal scripted query: each user message gets the messages the test emits for it, then a result.
function scriptedSdk(onUser) {
  function query({ prompt }) {
    const queue = [];
    let wake = null;
    const push = (message) => { queue.push(message); wake?.(); wake = null; };
    const api = { emit: push, result: (fields = {}) => push({ type: "result", subtype: "success", is_error: false, ...fields }) };
    (async () => {
      for await (const message of prompt) await onUser(message, api);
    })().catch(() => {});
    const iterator = (async function* stream() {
      for (;;) {
        if (!queue.length) await new Promise((resolve) => { wake = resolve; });
        yield queue.shift();
      }
    })();
    return {
      [Symbol.asyncIterator]: () => iterator[Symbol.asyncIterator](),
      async initializationResult() { return { models: [], commands: [] }; },
      async interrupt() {},
      async setPermissionMode() {},
      async getContextUsage() { return { totalTokens: 0, maxTokens: 1 }; },
      close() {},
    };
  }
  return { query };
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

test("a rejected rate_limit_event emits one LIMIT event with the window and reset", async () => {
  const sdk = scriptedSdk((message, api) => {
    api.emit({ type: "rate_limit_event", uuid: "00000000-0000-4000-8000-000000000001", session_id: "s1", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1893113200 } });
    api.emit({ type: "rate_limit_event", uuid: "00000000-0000-4000-8000-000000000002", session_id: "s1", rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.9 } });
    api.result();
  });
  const events = [];
  const adapter = createClaudeAdapter({ query: sdk.query });
  const ctx = { emit: (e) => events.push(e), log: () => {}, signal: new AbortController().signal };
  const handle = await adapter.open(OPTIONS, ctx);
  await handle.send({ text: "x" });
  const limit = await waitFor(() => events.find((e) => e.type === EventType.CUSTOM && e.name === LIMIT));
  assert.equal(eventProblem(limit), null);
  assert.equal(limit.value.harness, "claude");
  assert.equal(limit.value.window, "five_hour");
  assert.equal(limit.value.resetsAt, 1893113200000);
  assert.equal(events.filter((e) => e.name === LIMIT).length, 1);
  await handle.close();
});
