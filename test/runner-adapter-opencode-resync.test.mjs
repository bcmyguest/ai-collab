// OpenCode adapter: events missed while the stream was down (resync), subagent asks, and cards during a reply POST.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventType } from "@ag-ui/core";
import { APPROVAL_REQUESTED, APPROVAL_RESOLVED } from "../runner/contract.ts";
import { createOpenCodeAdapter } from "../runner/adapters/opencode.ts";
import { fakeOpencodeService } from "./helpers/fake-opencode-service.mjs";

const SID = "ses_test";
const CHILD = "ses_child";

async function until(check, what, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fakeCtx() {
  const events = [];
  return { events, emit: (e) => events.push(e), log: () => {}, signal: new AbortController().signal };
}

const ofType = (ctx, type) => ctx.events.filter((e) => e.type === type);
const cards = (ctx, name, id) => ctx.events.filter((e) => e.type === EventType.CUSTOM && e.name === name && (!id || e.value.interruptId === id));

async function openSession(svc, ctx, { status = "busy" } = {}) {
  svc.status[SID] = status;
  const adapter = createOpenCodeAdapter({ env: svc.env, retryMs: 20 });
  const handle = await adapter.open({ cwd: "/work", permission: { autoReply: [], reply: "once" } }, ctx);
  await until(() => svc.streams.length, "event stream");
  return { adapter, handle };
}

test("opencode ends the open run with RUN_ERROR when the stream dropped and the session is idle on reconnect", async () => {
  const svc = await fakeOpencodeService();
  const ctx = fakeCtx();
  const { adapter, handle } = await openSession(svc, ctx);
  try {
    const { runId } = await handle.send({ text: "work" });
    svc.emit({ type: "session.execution.started", data: { sessionID: SID } });
    await until(() => ofType(ctx, EventType.RUN_STARTED).length, "RUN_STARTED");
    svc.dropStreams();
    svc.status[SID] = "idle"; // the turn finished while the stream was down
    await until(() => ofType(ctx, EventType.RUN_ERROR).length, "RUN_ERROR after resync");
    assert.equal(ofType(ctx, EventType.RUN_ERROR)[0].metadata.aiCollab.runId, runId);
    await handle.send({ text: "again" }); // the handle is free for the next run
    assert.equal(svc.count("POST", `/api/session/${SID}/prompt`), 2);
    await handle.close();
  } finally {
    await adapter.shutdown();
    await svc.close();
  }
});

test("opencode keeps the run open after a reconnect when the session is still busy", async () => {
  const svc = await fakeOpencodeService();
  const ctx = fakeCtx();
  const { adapter, handle } = await openSession(svc, ctx);
  try {
    const { runId } = await handle.send({ text: "work" });
    svc.emit({ type: "session.execution.started", data: { sessionID: SID } });
    await until(() => ofType(ctx, EventType.RUN_STARTED).length, "RUN_STARTED");
    svc.dropStreams();
    await until(() => svc.count("GET", `/api/session/${SID}`) >= 1 && svc.streams.length, "reconnect and resync");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(ofType(ctx, EventType.RUN_ERROR).length, 0);
    svc.emit({ type: "session.execution.succeeded", data: { sessionID: SID } });
    await until(() => ofType(ctx, EventType.RUN_FINISHED).length, "RUN_FINISHED");
    assert.equal(ofType(ctx, EventType.RUN_FINISHED)[0].runId, runId);
    await handle.close();
  } finally {
    await adapter.shutdown();
    await svc.close();
  }
});

test("opencode surfaces an ask from a subagent child under the owned session and answers it on the child", async () => {
  const svc = await fakeOpencodeService();
  const ctx = fakeCtx();
  const { adapter, handle } = await openSession(svc, ctx, { status: "idle" });
  try {
    svc.emit({ type: "permission.asked", data: { id: "per_c", sessionID: CHILD, parentID: SID, action: "bash", message: "ls" } });
    await until(() => cards(ctx, APPROVAL_REQUESTED, "per_c").length, "approval card for the child ask");
    await handle.respond("per_c", { behavior: "allow" });
    const reply = svc.calls.find((c) => c.method === "POST" && c.path === `/api/session/${CHILD}/permission/per_c/reply`);
    assert.deepEqual(reply?.body, { decision: "once" });
    await handle.close();
  } finally {
    await adapter.shutdown();
    await svc.close();
  }
});

test("opencode child executions do not end the owned session's run", async () => {
  const svc = await fakeOpencodeService();
  const ctx = fakeCtx();
  const { adapter, handle } = await openSession(svc, ctx);
  try {
    await handle.send({ text: "work" });
    svc.emit({ type: "session.execution.started", data: { sessionID: SID } });
    await until(() => ofType(ctx, EventType.RUN_STARTED).length, "RUN_STARTED");
    svc.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD, parentID: SID } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(ofType(ctx, EventType.RUN_FINISHED).length, 0);
    await handle.close();
  } finally {
    await adapter.shutdown();
    await svc.close();
  }
});

test("opencode raises one card for an ask whose reply is in flight when the stream reconnects", async () => {
  const svc = await fakeOpencodeService({ permissions: { [SID]: [{ id: "per_1", action: "bash", message: "rm" }] } });
  const ctx = fakeCtx();
  const { adapter, handle } = await openSession(svc, ctx, { status: "idle" });
  try {
    svc.emit({ type: "permission.asked", data: { id: "per_1", sessionID: SID, action: "bash", message: "rm" } });
    await until(() => cards(ctx, APPROVAL_REQUESTED, "per_1").length, "first card");
    svc.holdReplies(true);
    const answered = handle.respond("per_1", { behavior: "allow" });
    await until(() => svc.count("POST", `/api/session/${SID}/permission/per_1/reply`), "reply POST");
    const before = svc.count("GET", `/api/session/${SID}/permission`);
    svc.dropStreams();
    await until(() => svc.count("GET", `/api/session/${SID}/permission`) > before && svc.streams.length, "resync during the reply");
    svc.holdReplies(false);
    svc.releaseReplies();
    await answered;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(cards(ctx, APPROVAL_REQUESTED, "per_1").length, 1, "one card for per_1");
    await handle.close();
  } finally {
    svc.releaseReplies();
    await adapter.shutdown();
    await svc.close();
  }
});

test("opencode closes a card whose ask the server no longer lists after a reconnect", async () => {
  const svc = await fakeOpencodeService({ permissions: { [SID]: [{ id: "per_1", action: "bash", message: "rm" }] } });
  const ctx = fakeCtx();
  const { adapter, handle } = await openSession(svc, ctx, { status: "idle" });
  try {
    svc.emit({ type: "permission.asked", data: { id: "per_1", sessionID: SID, action: "bash", message: "rm" } });
    await until(() => cards(ctx, APPROVAL_REQUESTED, "per_1").length, "card");
    svc.permissions[SID] = []; // answered elsewhere while the stream was down
    svc.dropStreams();
    const resolved = await until(() => cards(ctx, APPROVAL_RESOLVED, "per_1")[0], "card closed on resync");
    assert.deepEqual(resolved.value, { interruptId: "per_1", status: "cancelled", reason: "cancelled" });
    await handle.close();
  } finally {
    await adapter.shutdown();
    await svc.close();
  }
});
