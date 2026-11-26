// The runner's real flows on the DBOS engine: session start, live delivery, close, and wake.
// DBOS is a process singleton (one launch per process), so this file is one engine and one runner.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { EventType } from "@ag-ui/core";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { setup } from "./helpers/runner-ctx.mjs";
import { createFakeAdapter } from "../runner/adapters/fake.mjs";
import { createRunner, WAKE } from "../runner/runner.mjs";
import { listenControl, runnerSocket } from "../runner/control.mjs";
import { advanceRun, runStatus, startRun } from "../lib/pattern-runs.mjs";
import { saveTeamText } from "../lib/patterns.mjs";
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

test("runner on the dbos engine: session start, live message, close, wake delivery, and a pattern run", { skip: pgUp ? false : "no Postgres on 127.0.0.1:5432", timeout: 180_000 }, async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const adapter = createFakeAdapter({ harness: "codex" });
  // The pattern's reviewer hands off by printing PATTERN_ADVANCE, like the sqlite pattern suite's adapter.
  const claude = createFakeAdapter({ harness: "claude", capabilities: { places: ["openshell"] } });
  const openClaude = claude.open;
  claude.open = (options, context) => openClaude(options, {
    ...context,
    emit(event) {
      if (event.type === EventType.TEXT_MESSAGE_CHUNK && event.delta.includes('role "reviewer"')) {
        event = { ...event, delta: 'Reviewed.\nPATTERN_ADVANCE {"event":"approved","note":"complete"}' };
      }
      context.emit(event);
    },
  });
  // A per-run application version: parallel dbos test files must not recover each other's stragglers.
  const durable = await openWorkflows({ engine: "dbos", pgUrl: pgUrl(), applicationVersion: `ai-collab-test-${Date.now()}` });
  const runner = createRunner({ projects: [ctx.cfg], adapters: new Map([["codex", adapter], ["claude", claude]]), durable, env: ctx.env, startGapMs: 0, watch: true, pumpMs: 0 });
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

    // A pattern run on dbos: operator advances builder→reviewer, the reviewer's PATTERN_ADVANCE ends the run.
    const git = (...args) => execFileSync("git", ["-C", ctx.root, ...args], { env: ctx.env, stdio: "ignore" });
    git("init");
    git("-c", "user.name=Tests", "-c", "user.email=tests@example.test", "commit", "--allow-empty", "-m", "initial");
    await saveTeamText(ctx.cfg, "durable", `digraph durable {
      builder [agent=claude, prompt="Build"];
      reviewer [agent=claude, prompt="Review", code_mode=off];
      builder -> reviewer [on="ready", required=true];
      reviewer -> done [on="approved"];
    }`, ctx.env, {});
    const control = await listenControl(runner, runnerSocket(ctx.env));
    try {
      const started = await startRun(ctx.cfg, "durable", "Ship it", ctx.env);
      assert.equal(started.status, "running");
      const moved = await advanceRun(ctx.cfg, started.id, "ready", { env: ctx.env, override: true, by: "operator", note: "Changes ready" });
      assert.equal(moved.active, "reviewer");
      await until(() => runStatus(ctx.cfg, started.id).status === "done", "pattern done", 60_000);
      assert.equal((await durable.result(`pattern-${started.id}`)).status, "done");
    } finally {
      await control.close();
    }
  } finally {
    await runner.stop().catch(() => {}); // stop() closes the engine; a second close() would end the pool twice
    await fake.close();
  }
});
