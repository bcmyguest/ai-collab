// Claude adapter: a CLI that never answers the handshake fails open and resume within the bound, and closes its query.
import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeAdapter } from "../runner/adapters/claude.ts";
import { fakeClaudeQuery } from "./helpers/fake-claude-query.mjs";

function fakeCtx() {
  return { events: [], emit(e) { this.events.push(e); }, log: () => {}, signal: new AbortController().signal };
}

test("claude open fails with a clear error and closes the query when the CLI does not answer the handshake", async () => {
  const fake = fakeClaudeQuery({ hang: true });
  const adapter = createClaudeAdapter({ query: fake.query, handshakeMs: 30 });
  await assert.rejects(
    adapter.open({ cwd: "/work", permission: { permissionMode: "default" }, env: {} }, fakeCtx()),
    /claude session failed to start: no response from the CLI within/,
  );
  assert.equal(fake.queries.length, 1);
  assert.equal(fake.queries[0].closed, true, "the hung query is closed");
});

test("claude resume fails with a clear error and closes the query when the CLI does not answer the handshake", async () => {
  const fake = fakeClaudeQuery({ hang: true });
  const adapter = createClaudeAdapter({ query: fake.query, handshakeMs: 30 });
  const record = { nativeId: "11111111-2222-4333-8444-555555555555", cwd: "/work", permissionMode: "supervised", place: "folder" };
  await assert.rejects(adapter.resume(record, fakeCtx(), {}), /claude resume failed to start: no response from the CLI within/);
  assert.equal(fake.queries[0].closed, true);
});

test("claude open still returns a handle when the handshake answers within the bound", async () => {
  const fake = fakeClaudeQuery();
  const adapter = createClaudeAdapter({ query: fake.query, handshakeMs: 30 });
  const handle = await adapter.open({ cwd: "/work", permission: { permissionMode: "default" }, env: {} }, fakeCtx());
  assert.equal(handle.nativeId, fake.queries[0].options.sessionId);
  assert.equal(fake.queries[0].closed, false);
  await handle.close();
});
