// The owned record exists before an adapter starts its child on open(), so the child's SessionStart hook stands down.
import test from "node:test";
import assert from "node:assert/strict";
import { sessionLabel } from "../lib/config.mjs";
import { readOwned } from "../lib/sessions/registry.ts";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { makeRunner, setup } from "./helpers/runner-ctx.mjs";
import { createFakeAdapter } from "../runner/adapters/fake.mjs";
import { createClaudeAdapter } from "../runner/adapters/claude.mjs";
import { fakeClaudeQuery } from "./helpers/fake-claude-query.mjs";
import { wrapOpen } from "./helpers/fake-adapter-hooks.mjs";

function fakeCtx() {
  return { events: [], emit(e) { this.events.push(e); }, log: () => {}, signal: new AbortController().signal };
}

test("claude open calls beforeStart with the native id before the query starts", async () => {
  const fake = fakeClaudeQuery();
  const adapter = createClaudeAdapter({ query: fake.query, handshakeMs: 1000 });
  const seen = [];
  const handle = await adapter.open({
    cwd: "/work", permission: { permissionMode: "default" }, env: {},
    beforeStart(nativeId) { seen.push(nativeId); fake.events.push("beforeStart"); },
  }, fakeCtx());
  assert.deepEqual(fake.events, ["beforeStart", "query"]);
  assert.deepEqual(seen, [fake.queries[0].options.sessionId]);
  assert.equal(handle.nativeId, seen[0]);
  await handle.close();
});

test("the runner writes the owned record in status starting before the adapter's open returns", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const base = createFakeAdapter({ harness: "claude" });
  const snapshots = [];
  const adapter = wrapOpen(base, async (options, context, baseOpen) => {
    // Stands in for a Claude child that reads its owned record on start: the record must already exist here.
    const nativeId = "native-before-start-1";
    await options.beforeStart(nativeId);
    snapshots.push(readOwned(ctx.cfg, sessionLabel(nativeId)));
    return baseOpen(options, context);
  });
  const { runner } = makeRunner(ctx, [adapter], { watch: false });
  await runner.boot();
  try {
    await runner.start({ project: "demo", harness: "claude", prompt: "hello" });
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].status, "starting");
    assert.equal(snapshots[0].nativeId, "native-before-start-1");
    assert.equal(snapshots[0].harness, "claude");
  } finally {
    await runner.stop();
    await fake.close();
  }
});
