// The runner's real flows on the DBOS engine: session start, live delivery, close, and wake.
// DBOS is a process singleton (one launch per process), so this file is one engine and one runner.
import assert from "node:assert/strict";
import test from "node:test";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { setup } from "./helpers/runner-ctx.mjs";
import { createFakeAdapter } from "../runner/adapters/fake.mjs";
import { createRunner, WAKE } from "../runner/runner.mjs";
import { openWorkflows } from "../lib/workflows.ts";
import { pgReachable, pgUrl } from "../lib/postgres.mjs";
import { sessionLabel } from "../lib/config.mjs";

const pgUp = await pgReachable();
const direct = (label, body) => JSON.stringify({ v: 1, kind: "msg", from: "operator", to: "codex", toSession: label, operatorThread: true, ts: new Date().toISOString(), body });

async function until(check, what, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("runner on the dbos engine: session start, live message, close, and wake delivery", { skip: pgUp ? false : "no Postgres on 127.0.0.1:5432", timeout: 120_000 }, async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const adapter = createFakeAdapter({ harness: "codex" });
  // A per-run application version: parallel dbos test files must not recover each other's stragglers.
  const durable = await openWorkflows({ engine: "dbos", pgUrl: pgUrl(), applicationVersion: `ai-collab-test-${Date.now()}` });
  const runner = createRunner({ projects: [ctx.cfg], adapters: new Map([["codex", adapter]]), durable, env: ctx.env, startGapMs: 0, watch: true, pumpMs: 0 });
  await runner.boot();
  try {
    const { session, nativeId } = await runner.start({ project: "demo", harness: "codex", prompt: "first" });
    await until(() => runner.get(session).status === "idle", "idle");
    assert.equal((await durable.status(runner.get(session).workflowId)).status, "PENDING", "the live session workflow is PENDING on dbos");

    fake.inject("ai-collab-demo--to--codex", direct(sessionLabel(nativeId), "hello live"));
    await until(() => adapter.calls.some((c) => c.op === "send" && /hello live/.test(c.text || "")), "live delivery");

    await runner.close(session);
    await until(() => runner.get(session).status === "ended", "ended");

    const ev = fake.inject("ai-collab-demo--to--codex", direct(sessionLabel(nativeId), "wake up please"));
    const wakeId = `${WAKE}:${session}:${ev.id}`;
    await until(async () => (await durable.status(wakeId))?.status === "SUCCESS", "wake", 20_000);
    assert.equal((await durable.status(wakeId)).output.ended, "closed again after a message");
    assert.ok(adapter.calls.some((c) => c.op === "resume"), "the closed session was resumed through the adapter");
  } finally {
    await runner.stop().catch(() => {}); // stop() closes the engine; a second close() would end the pool twice
    await fake.close();
  }
});
