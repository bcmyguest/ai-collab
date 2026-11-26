// Reviewer finding 3 (caveat): the sqlite engine dedupes sends globally (UNIQUE dedupe column),
// but DBOS scopes idempotencyKey per destination. The engine surface must match: a dedupe key spent
// toward one workflow is spent, whichever workflow a repeat targets.
import assert from "node:assert/strict";
import test from "node:test";
import { openWorkflows } from "../lib/workflows.ts";
import { pgReachable, pgUrl } from "../lib/postgres.mjs";

const pgUp = await pgReachable();

test("send dedupe is global across destinations, like the sqlite engine", { skip: pgUp ? false : "no Postgres on 127.0.0.1:5432", timeout: 60_000 }, async () => {
  const wf = await openWorkflows({ engine: "dbos", pgUrl: pgUrl(), applicationVersion: `aic-dedupe-${Date.now()}` });
  wf.register("d.wait", async (ctx) => await ctx.recv("inbox"));
  const stamp = Date.now();
  const a = `dedupe-a-${stamp}`;
  const b = `dedupe-b-${stamp}`;
  const wa = wf.startWorkflow("d.wait", a, {});
  const wb = wf.startWorkflow("d.wait", b, {});
  wb.catch(() => {});
  try {
    assert.equal(await wf.send(a, "inbox", "one", { dedupe: `k-${stamp}` }), true, "the first send is fresh");
    assert.equal(await wf.send(b, "inbox", "two", { dedupe: `k-${stamp}` }), false, "the same key toward another destination is a repeat");
    assert.equal(await wa, "one");
    await wf.cancel(b);
  } finally {
    await wf.close();
  }
});
