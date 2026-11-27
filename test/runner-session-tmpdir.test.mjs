import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { makeRunner, setup, until } from "./helpers/runner-ctx.mjs";
import { createFakeAdapter } from "../runner/adapters/fake.mjs";

test("an owned session runs with its own TMPDIR, removed when it ends", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const adapter = createFakeAdapter({ harness: "codex" });
  const { runner } = makeRunner(ctx, [adapter]);
  await runner.boot();
  try {
    const { session, workflowId } = await runner.start({ project: "demo", harness: "codex", prompt: "first" });
    const dir = path.join(ctx.env.AI_COLLAB_STATE_DIR, "tmp", workflowId);
    const { env } = adapter.calls.find((c) => c.op === "open").options;
    assert.deepEqual([env.TMPDIR, env.TMP, env.TEMP], [dir, dir, dir]);
    assert.equal(existsSync(dir), true);
    await until(() => runner.get(session).status === "idle", "idle");
    await runner.close(session);
    await until(() => runner.get(session).status === "ended", "ended");
    assert.equal(existsSync(dir), false);
  } finally {
    await runner.stop();
    await fake.close();
  }
});

test("boot removes temp dirs of sessions that do not recover and keeps those that do", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const first = makeRunner(ctx, [createFakeAdapter({ harness: "codex" })]).runner;
  await first.boot();
  const { session, workflowId } = await first.start({ project: "demo", harness: "codex", prompt: "first" });
  await until(() => first.get(session).status === "idle", "idle").finally(() => first.stop());
  const live = path.join(ctx.env.AI_COLLAB_STATE_DIR, "tmp", workflowId);
  const stale = path.join(ctx.env.AI_COLLAB_STATE_DIR, "tmp", "session-gone");
  mkdirSync(path.join(stale, "leaked"), { recursive: true });
  const { runner } = makeRunner(ctx, [createFakeAdapter({ harness: "codex" })]);
  try {
    assert.equal((await runner.boot()).length, 1);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(live), true);
  } finally {
    await runner.stop();
    await fake.close();
  }
});
