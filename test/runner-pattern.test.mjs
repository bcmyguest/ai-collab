import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventType } from "@ag-ui/core";
import { advanceRun, runStatus, startRun } from "../lib/pattern-runs.mjs";
import { saveTeamText } from "../lib/patterns.mjs";
import { createFakeAdapter } from "../runner/adapters/fake.mjs";
import { listenControl, runnerSocket } from "../runner/control.ts";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { makeRunner, setup, until } from "./helpers/runner-ctx.mjs";

test("a DOT pattern resumes after runner restart and accepts agent and operator advances", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  let runner, control;
  try {
    const git = (...args) => execFileSync("git", ["-C", ctx.root, ...args], { env: ctx.env, stdio: "ignore" });
    git("init");
    git("-c", "user.name=Tests", "-c", "user.email=tests@example.test", "commit", "--allow-empty", "-m", "initial");
    const pattern = await saveTeamText(ctx.cfg, "durable", `digraph durable {
      builder [agent=claude, prompt="Build"];
      reviewer [agent=claude, prompt="Review", code_mode=off];
      builder -> reviewer [on="ready", required=true];
      reviewer -> done [on="approved"];
    }`, ctx.env, {});
    const adapter = createFakeAdapter({ harness: "claude", capabilities: { places: ["openshell"] } });
    const open = adapter.open;
    adapter.open = (options, context) => open(options, {
      ...context,
      emit(event) {
        if (event.type === EventType.TEXT_MESSAGE_CHUNK && event.delta.includes('role "reviewer"')) {
          event = { ...event, delta: 'Reviewed.\nPATTERN_ADVANCE {"event":"approved","note":"complete"}' };
        }
        context.emit(event);
      },
    });
    const boot = async () => {
      const instance = makeRunner(ctx, [adapter]);
      runner = instance.runner;
      await runner.boot();
      control = await listenControl(runner, runnerSocket(ctx.env));
      return instance.durable;
    };
    await boot();
    const started = await startRun(ctx.cfg, "durable", "Ship it", ctx.env);
    assert.equal(started.status, "running");
    assert.match(started.session, /^claude#/);
    await assert.rejects(advanceRun(ctx.cfg, started.id, "ready", { env: ctx.env, caller: "claude#other" }), /only the active role/);
    await control.close();
    await runner.stop();

    // Recovery must use the compiled graph that the run started with.
    writeFileSync(pattern.file, "invalid");
    const durable = await boot();
    const workflow = `pattern-${started.id}`;
    assert.equal(durable.status(workflow).status, "PENDING");
    assert.equal(runner.list().length, 1);
    const moved = await advanceRun(ctx.cfg, started.id, "ready", { env: ctx.env, override: true, by: "operator", note: "Changes ready" });
    assert.equal(moved.active, "reviewer");
    const opens = adapter.calls.filter((call) => call.op === "open").map((call) => call.options);
    assert.equal(opens.length, 2);
    assert.ok(opens.every(({ place, cwd, patternRun }) => place === "openshell" && cwd === opens[0].cwd && cwd !== ctx.root && patternRun === started.id));
    assert.ok(existsSync(join(ctx.cfg.stateDir, "runner", "pattern-runs", ctx.cfg.project, started.id + ".json")));
    await until(() => runStatus(ctx.cfg, started.id).status === "done", "reviewer handoff");
    assert.equal((await durable.result(workflow)).status, "done");
    const stepNames = durable.steps(workflow).map((step) => step.name);
    assert.ok(stepNames.includes("enter") && stepNames.includes("event") && stepNames.includes("leave"));
    const recorded = durable.listNamed("pattern", 10).find((row) => row.id === workflow);
    assert.equal(recorded.input.name, "durable");
    assert.equal(recorded.input.task, "Ship it");
    assert.equal(recorded.input.definition.roles[0].id, "builder");
    assert.equal(runStatus(ctx.cfg, started.id).handoffs[0].by, "operator");
    assert.equal(runStatus(ctx.cfg, started.id).handoffs[1].note, "complete");
  } finally {
    await control?.close();
    await runner?.stop();
    await fake.close();
    rmSync(ctx.home, { recursive: true, force: true });
  }
});
