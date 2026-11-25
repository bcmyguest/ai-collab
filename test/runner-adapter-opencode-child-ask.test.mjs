// OpenCode adapter: the real permission.asked event names only sessionID, so a subagent ask needs the child's parent from the API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventType } from "@ag-ui/core";
import { APPROVAL_REQUESTED } from "../runner/contract.mjs";
import { createOpenCodeAdapter } from "../runner/adapters/opencode.mjs";
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

const cards = (ctx, id) => ctx.events.filter((e) => e.type === EventType.CUSTOM && e.name === APPROVAL_REQUESTED && e.value.interruptId === id);

test("opencode surfaces a subagent ask that carries no parentID by reading the child's session", async () => {
  const svc = await fakeOpencodeService({ parents: { [CHILD]: SID } });
  const events = [];
  const ctx = { events, emit: (e) => events.push(e), log: () => {}, signal: new AbortController().signal };
  const adapter = createOpenCodeAdapter({ env: svc.env, retryMs: 20 });
  const handle = await adapter.open({ cwd: "/work", permission: { autoReply: [], reply: "once" } }, ctx);
  try {
    await until(() => svc.streams.length, "event stream");
    svc.emit({ type: "permission.asked", data: { id: "per_n", sessionID: CHILD, action: "bash", resources: ["ls"] } });
    await until(() => cards(ctx, "per_n").length, "approval card for the child ask");
    await handle.respond("per_n", { behavior: "allow" });
    const reply = svc.calls.find((c) => c.method === "POST" && c.path === `/api/session/${CHILD}/permission/per_n/reply`);
    assert.deepEqual(reply?.body, { decision: "once" });
    svc.emit({ type: "permission.asked", data: { id: "per_x", sessionID: "ses_other", action: "bash", resources: ["ls"] } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(cards(ctx, "per_x").length, 0, "an unrelated session's ask stays out");
    await handle.close();
  } finally {
    await adapter.shutdown();
    await svc.close();
  }
});

test("opencode resolves a child's owner once, so repeat asks from the child cost no parent lookups", async () => {
  const svc = await fakeOpencodeService({ parents: { [CHILD]: SID } });
  const events = [];
  const ctx = { events, emit: (e) => events.push(e), log: () => {}, signal: new AbortController().signal };
  const adapter = createOpenCodeAdapter({ env: svc.env, retryMs: 20 });
  const handle = await adapter.open({ cwd: "/work", permission: { autoReply: [], reply: "once" } }, ctx);
  try {
    await until(() => svc.streams.length, "event stream");
    svc.emit({ type: "permission.asked", data: { id: "per_c1", sessionID: CHILD, action: "bash", resources: ["ls"] } });
    await until(() => cards(ctx, "per_c1").length, "first child ask");
    svc.emit({ type: "permission.asked", data: { id: "per_c2", sessionID: CHILD, action: "bash", resources: ["pwd"] } });
    await until(() => cards(ctx, "per_c2").length, "second child ask");
    assert.equal(svc.count("GET", `/api/session/${CHILD}`), 1, "the child was looked up more than once");
    await handle.close();
  } finally {
    await adapter.shutdown();
    await svc.close();
  }
});

test("opencode surfaces a grandchild's ask when the event names an unowned parent", async () => {
  const GRAND = "ses_grand";
  const svc = await fakeOpencodeService({ parents: { [CHILD]: SID, [GRAND]: CHILD } });
  const events = [];
  const ctx = { events, emit: (e) => events.push(e), log: () => {}, signal: new AbortController().signal };
  const adapter = createOpenCodeAdapter({ env: svc.env, retryMs: 20 });
  const handle = await adapter.open({ cwd: "/work", permission: { autoReply: [], reply: "once" } }, ctx);
  try {
    await until(() => svc.streams.length, "event stream");
    svc.emit({ type: "permission.asked", data: { id: "per_g", sessionID: GRAND, parentID: CHILD, action: "bash", resources: ["ls"] } });
    await until(() => cards(ctx, "per_g").length, "approval card for the grandchild ask");
    await handle.close();
  } finally {
    await adapter.shutdown();
    await svc.close();
  }
});
