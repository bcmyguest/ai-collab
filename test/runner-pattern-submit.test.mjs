// Reviewer finding N2: waitForPattern called submit(request) without awaiting it, so a rejecting
// submit (a DBOS start guard, say) is an unhandled rejection that crashes the runner. The failure
// must come into the race and answer the request as a 409.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { saveTeamText } from "../lib/catalog/patterns.ts";
import { adaptSqlite } from "../lib/workflows.ts";
import { createFakeAdapter } from "../runner/adapters/fake.ts";
import { openDurable } from "../lib/durable.ts";
import { createRunner } from "../runner/runner.ts";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { setup } from "./helpers/runner-ctx.mjs";

test("a rejected pattern submit answers the request instead of crashing the runner", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const git = (...args) => execFileSync("git", ["-C", ctx.root, ...args], { env: ctx.env, stdio: "ignore" });
  git("init");
  git("-c", "user.name=Tests", "-c", "user.email=tests@example.test", "commit", "--allow-empty", "-m", "initial");
  const adapter = createFakeAdapter({ harness: "claude", capabilities: { places: ["openshell"] } });
  const raw = openDurable(ctx.db);
  const adapted = adaptSqlite(raw);
  const durable = {
    ...adapted,
    startWorkflow: (name, id, input) => name === "pattern"
      ? Promise.reject(new Error("dbos start refused"))
      : adapted.startWorkflow(name, id, input),
  };
  const runner = createRunner({ projects: [ctx.cfg], adapters: new Map([["claude", adapter]]), durable, env: ctx.env, startGapMs: 0, watch: false, pumpMs: 0 });
  try {
    await runner.boot();
    await saveTeamText(ctx.cfg, "solo", `digraph solo {
      worker [agent=claude, prompt="Work"];
      worker -> done [on="finished"];
    }`, ctx.env, {});
    await assert.rejects(
      runner.startPattern({ project: "demo", name: "solo", task: "Ship it" }),
      { status: 409, message: /pattern submit failed: dbos start refused/ },
    );
  } finally {
    await runner.stop();
    await raw.close();
    await fake.close();
  }
});
