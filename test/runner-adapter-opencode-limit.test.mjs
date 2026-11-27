// A bare provider 429 reaches the limit classifier: the OpenCode adapter forwards the HTTP status, lib/limits.ts reads it.
// The adapter drives the scripted fake service only; no OpenCode process runs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventType } from "@ag-ui/core";
import { createOpenCodeAdapter } from "../runner/adapters/opencode.mjs";
import { limitFromRunError } from "../lib/limits.ts";
import { eventProblem } from "../runner/contract.ts";
import { fakeOpencodeService } from "./helpers/fake-opencode-service.mjs";

const SID = "ses_test";

function fakeCtx() {
  const events = [];
  return { events, emit: (event) => events.push(event), log: () => {}, signal: new AbortController().signal };
}

const ofType = (ctx, type) => ctx.events.filter((e) => e.type === type);

async function until(check, ms = 4000) {
  const began = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - began > ms) throw new Error("timed out waiting for an event");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function failedRun(t, data) {
  // The session reports busy, so the adapter's resync on connect cannot end the run before the injected failure arrives.
  const svc = await fakeOpencodeService({ status: { [SID]: "busy" } });
  const adapter = createOpenCodeAdapter({ env: svc.env, retryMs: 20 });
  try {
    const ctx = fakeCtx();
    const handle = await adapter.open({ cwd: "/work", permission: { autoReply: [], reply: "once" } }, ctx);
    await until(() => svc.streams.length, 4000);
    const { runId } = await handle.send({ text: "go" });
    svc.emit({ type: "session.execution.failed", data: { sessionID: SID, ...data } });
    const error = await until(() => ofType(ctx, EventType.RUN_ERROR)[0]);
    await handle.close();
    return { error, runId };
  } finally {
    await adapter.shutdown();
    await svc.close();
  }
}

test("a provider 429 on the failed execution reaches RUN_ERROR metadata and classifies as an UNVERIFIED bare rate limit", async (t) => {
  const { error, runId } = await failedRun(t, { status: 429, error: { message: "Too Many Requests" } });
  assert.equal(error.metadata.aiCollab.runId, runId);
  assert.equal(error.metadata.aiCollab.status, 429);
  assert.equal(eventProblem(error), null);
  const limit = limitFromRunError("opencode", error.message, error.metadata.aiCollab);
  assert.equal(limit?.harness, "opencode");
  assert.equal(limit?.source, "UNVERIFIED HTTP 429 from provider");
  // A bare 429 names no window and no explicit limit wording: the card reads "Rate limited".
  assert.equal(limit?.windowName, null);
  assert.equal(limit?.wording, false);
  assert.equal(limit?.verified, false);
});

test("a status nested in the provider error still reaches RUN_ERROR metadata", async (t) => {
  const { error } = await failedRun(t, { error: { message: "provider said no", statusCode: 429 } });
  assert.equal(error.metadata.aiCollab.status, 429);
  assert.equal(limitFromRunError("opencode", error.message, error.metadata.aiCollab)?.source, "UNVERIFIED HTTP 429 from provider");
});

test("an execution failure without a status carries none, so only the text can classify it", async (t) => {
  const { error } = await failedRun(t, { error: { message: "provider quota exceeded" } });
  assert.equal("status" in error.metadata.aiCollab, false);
  const limit = limitFromRunError("opencode", error.message, error.metadata.aiCollab);
  assert.equal(limit?.source, "UNVERIFIED provider error text");
  assert.equal(limit?.wording, true);
});
