import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeAdapter } from "../runner/adapters/claude.ts";
import { createFakeAdapter } from "../runner/adapters/fake.ts";
import { readOwned, writeOwned } from "../lib/sessions/registry.ts";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { makeRunner, setup, until } from "./helpers/runner-ctx.mjs";

const OPTIONS = { project: "demo", cwd: "/tmp/demo", permission: { permissionMode: "default" }, env: { PATH: "/usr/bin" } };

// An SDK query stub: records the options, ends after the init handshake, and refuses bypass without the allow flag.
function stubSdk() {
  const queries = [];
  function query({ options }) {
    const record = { options, modes: [] };
    queries.push(record);
    let done = null;
    return {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise((resolve) => { done = resolve; }) }),
      async initializationResult() { return { models: [], commands: [] }; },
      async setPermissionMode(mode) {
        if (mode === "bypassPermissions" && !options.allowDangerouslySkipPermissions) throw new Error("session was not launched with --dangerously-skip-permissions");
        record.modes.push(mode);
      },
      close() { done?.({ done: true, value: undefined }); },
    };
  }
  return { query, queries };
}

const ctxStub = { emit: () => {}, log: () => {} };

test("a Claude query opened with allowFullAccess can switch to full-access live; one opened without it cannot", async () => {
  const sdk = stubSdk();
  const adapter = createClaudeAdapter({ query: sdk.query, handshakeMs: 1000 });
  const allowed = await adapter.open({ ...OPTIONS, allowFullAccess: true }, ctxStub);
  assert.equal(sdk.queries[0].options.allowDangerouslySkipPermissions, true);
  await allowed.setPermissionMode("full-access");
  assert.deepEqual(sdk.queries[0].modes, ["bypassPermissions"]);
  const plain = await adapter.open(OPTIONS, ctxStub);
  assert.equal(sdk.queries[1].options.allowDangerouslySkipPermissions, undefined);
  await assert.rejects(plain.setPermissionMode("full-access"), /dangerously-skip-permissions/);
  const resumed = await adapter.resume({ nativeId: "6f1d2c3a-4b5e-4f60-8a7b-9c0d1e2f3a4b", cwd: "/tmp/demo", place: "folder", permissionMode: "supervised", allowFullAccess: true }, ctxStub, { PATH: "/usr/bin" });
  assert.equal(sdk.queries[2].options.allowDangerouslySkipPermissions, true);
  await Promise.all([allowed.close(), plain.close(), resumed.close()]);
});

test("the runner opens a session with allowFullAccess only where it allows full-access", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  for (const [extra, allowed] of [[{}, false], [{ AI_COLLAB_ALLOW_HOST_AGENT: "1" }, true]]) {
    const ctx = setup(fake);
    ctx.env = { ...ctx.env, ...extra };
    const adapter = createFakeAdapter({ harness: "claude" });
    const { runner } = makeRunner(ctx, [adapter]);
    await runner.boot();
    t.after(() => runner.stop());
    await runner.start({ project: "demo", harness: "claude", prompt: "hi", place: "folder" });
    assert.equal(adapter.calls.find((c) => c.op === "open").options.allowFullAccess, allowed);
  }
});

test("a harness that refuses a mode switch answers 409 with its reason and leaves the record's mode", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const ctx = setup(fake);
  const adapter = createFakeAdapter({ harness: "claude" });
  const open = adapter.open.bind(adapter);
  adapter.open = async (...args) => Object.assign(await open(...args), { setPermissionMode: async () => { throw new Error("not launched for bypass"); } });
  const { runner } = makeRunner(ctx, [adapter]);
  await runner.boot();
  t.after(() => runner.stop());
  const { session } = await runner.start({ project: "demo", harness: "claude", prompt: "hi", place: "folder" });
  await assert.rejects(runner.setMode(session, "accept-edits"), (error) => error.status === 409 && /refused permission mode accept-edits: not launched for bypass/.test(error.message));
  assert.equal(runner.get(session).permissionMode, "supervised");
});

test("/mode drops a stored /permission value, so the next wake keeps the new mode", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const ctx = setup(fake);
  const first = makeRunner(ctx, [createFakeAdapter({ harness: "claude" })]).runner;
  await first.boot();
  const { session } = await first.start({ project: "demo", harness: "claude", prompt: "hi", place: "folder" });
  await until(() => first.get(session).status === "idle", "idle");
  await first.stop();
  const label = session.split("#")[1];
  writeOwned(ctx.cfg, { ...readOwned(ctx.cfg, label), label, claudePermission: "dontAsk" });
  const adapter = createFakeAdapter({ harness: "claude" });
  const resumes = [];
  const resume = adapter.resume.bind(adapter);
  adapter.resume = async (record, ...rest) => { resumes.push(record.claudePermission); return resume(record, ...rest); };
  const second = makeRunner(ctx, [adapter]).runner;
  await second.boot();
  t.after(() => second.stop());
  assert.deepEqual(await second.setMode(session, "accept-edits"), { status: "changed", permissionMode: "accept-edits" });
  assert.deepEqual(resumes, ["dontAsk"]);
  assert.equal(readOwned(ctx.cfg, label).claudePermission, undefined);
  assert.equal(readOwned(ctx.cfg, label).permissionMode, "accept-edits");
});
