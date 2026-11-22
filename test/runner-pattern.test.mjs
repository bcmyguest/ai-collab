import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { advanceRun, runStatus, startRun } from "../lib/pattern-runs.mjs";
import { saveTeamText } from "../lib/patterns.mjs";
import { createFakeAdapter } from "../runner/adapters/fake.mjs";
import { listenControl, runnerSocket } from "../runner/control.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { makeRunner, setup } from "./helpers/runner-ctx.mjs";

test("a DOT pattern resumes after runner restart and accepts agent and operator advances", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  let runner, control;
  try {
    const pattern = await saveTeamText(ctx.cfg, "durable", `digraph durable {
      builder [agent=codex, prompt="Build"];
      reviewer [agent=codex, prompt="Review", code_mode=off];
      builder -> reviewer [on="ready", required=true];
      reviewer -> done [on="approved"];
    }`, ctx.env, {});
    const boot = async () => {
      const instance = makeRunner(ctx, [createFakeAdapter({ harness: "codex" })]);
      runner = instance.runner;
      await runner.boot();
      control = await listenControl(runner, runnerSocket(ctx.env));
      return instance.durable;
    };
    await boot();
    const started = await startRun(ctx.cfg, "durable", "Ship it", ctx.env);
    assert.equal(started.status, "running");
    assert.match(started.session, /^codex#/);
    await assert.rejects(advanceRun(ctx.cfg, started.id, "ready", { env: ctx.env, caller: "codex#other" }), /only the active role/);
    await control.close();
    await runner.stop();

    // Recovery must use the compiled graph that the run started with.
    writeFileSync(pattern.file, "invalid");
    const durable = await boot();
    const workflow = `pattern:demo:${started.id}`;
    assert.equal(durable.status(workflow).status, "PENDING");
    assert.equal(runner.list().length, 1);
    const moved = await advanceRun(ctx.cfg, started.id, "ready", { env: ctx.env, caller: started.session, note: "Changes ready" });
    assert.equal(moved.active, "reviewer");
    const done = await advanceRun(ctx.cfg, started.id, "approved", { env: ctx.env, override: true, by: "operator" });
    assert.equal(done.status, "done");
    assert.equal((await durable.result(workflow)).status, "done");
    assert.equal(runStatus(ctx.cfg, started.id).handoffs[1].by, "operator");
  } finally {
    await control?.close();
    await runner?.stop();
    await fake.close();
    rmSync(ctx.home, { recursive: true, force: true });
  }
});
