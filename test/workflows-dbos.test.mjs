// The DBOS engine must satisfy the same contract as the sqlite durable log. Skips when Postgres is down.
import assert from "node:assert/strict";
import test from "node:test";
import { openWorkflows } from "../lib/workflows.ts";
import { pgReachable, pgUrl } from "../lib/postgres.mjs";

const pgUp = await pgReachable();
const opts = { engine: "dbos", pgUrl: pgUp ? pgUrl() : "" };
const t = test("dbos engine", { skip: pgUp ? false : "no Postgres on 127.0.0.1:5432" }, async () => {
  const wf = await openWorkflows(opts);
  const stamp = Date.now();
  let ticks = 0;
  // DBOS registers workflows at launch (the first async call), so register everything up front.
  wf.register("t.add", async (ctx, input) => {
    const doubled = await ctx.step("double", async () => Number(input.x) * 2);
    return doubled + 1;
  });
  wf.register("t.wait", async (ctx) => await ctx.recv("inbox"));
  wf.register("t.all", async (ctx) => await ctx.recv("inbox", { all: true }));
  wf.register("t.none", async (ctx) => await ctx.recv("inbox", { all: true, timeoutSeconds: 0 }));
  wf.register("t.long", async (ctx) => { await ctx.pause(60_000); return "never"; });
  wf.register("t.hold", async (ctx) => { await ctx.pause(60_000); return "never"; });
  let sigAborted = false;
  wf.register("t.sig", async (ctx) => await new Promise((resolve) => {
    ctx.signal.addEventListener("abort", () => { sigAborted = true; resolve("aborted"); }, { once: true });
  }));
  wf.scheduled("t.every", { everyMs: 60_000 }, async () => { ticks += 1; });
  try {
    // start + step + result
    const out = await wf.startWorkflow("t.add", `add-${stamp}`, { x: 20 });
    assert.equal(out, 41);
    const st = await wf.status(`add-${stamp}`);
    assert.equal(st.status, "SUCCESS");
    assert.equal(st.output, 41);
    assert.equal(await wf.result(`add-${stamp}`), 41);

    // startWorkflowOnce: the second start of an id reports false
    assert.equal(await wf.startWorkflowOnce("t.add", `once-${stamp}`, { x: 1 }), true);
    assert.equal(await wf.startWorkflowOnce("t.add", `once-${stamp}`, { x: 1 }), false);

    // send / recv: a workflow waits for a message, dedupe drops repeats
    const waiting = wf.startWorkflow("t.wait", `wait-${stamp}`, {});
    assert.equal(await wf.send(`wait-${stamp}`, "inbox", "hello", { dedupe: `d-${stamp}` }), true);
    assert.equal(await wf.send(`wait-${stamp}`, "inbox", "hello", { dedupe: `d-${stamp}` }), false);
    assert.equal(await waiting, "hello");

    // a failed send must not spend the dedupe key: the retry after the destination exists must deliver
    const ghost = `ghost-${stamp}`;
    await assert.rejects(wf.send(ghost, "inbox", "late", { dedupe: `late-${stamp}` }));
    assert.equal(await wf.startWorkflowOnce("t.wait", ghost, {}), true);
    assert.equal(await wf.send(ghost, "inbox", "late", { dedupe: `late-${stamp}` }), true);
    assert.equal(await wf.result(ghost), "late");

    // recv-all blocks for the first message then takes the backlog; timeoutSeconds 0 never waits
    const backlog = `backlog-${stamp}`;
    let backlogDone = false;
    const backlogP = wf.startWorkflow("t.all", backlog, {}).then((v) => { backlogDone = true; return v; });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(backlogDone, false, "recv-all waits for the first message");
    await wf.send(backlog, "inbox", "b1");
    await wf.send(backlog, "inbox", "b2");
    assert.deepEqual(await backlogP, ["b1", "b2"]);
    assert.deepEqual(await wf.startWorkflow("t.none", `none-${stamp}`, {}), []);

    // listNamed returns newest first with parsed fields
    const rows = await wf.listNamed("t.add", 10);
    assert.ok(rows.some((r) => r.id === `add-${stamp}` && r.status === "SUCCESS"));

    // cancel
    const long = wf.startWorkflow("t.long", `long-${stamp}`, {});
    long.catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    await wf.cancel(`long-${stamp}`);
    assert.equal((await wf.status(`long-${stamp}`)).status, "CANCELLED");

    // cancel must also abort the context signal so the workflow itself unwinds
    const sig = wf.startWorkflow("t.sig", `sig-${stamp}`, {});
    await new Promise((r) => setTimeout(r, 200));
    await wf.cancel(`sig-${stamp}`);
    assert.equal(sigAborted, true, "cancel must abort the workflow context signal");
    await assert.rejects(sig); // the cancelled outcome wins; the workflow woke on its signal

    // kv round-trip
    await wf.setKv(`k-${stamp}`, { a: 1 });
    assert.deepEqual(await wf.getKv(`k-${stamp}`), { a: 1 });

    // pendingCount + drain on a workflow that is not consuming (the wake handover case)
    const hold = wf.startWorkflow("t.hold", `hold-${stamp}`, {});
    hold.catch(() => {});
    await wf.send(`hold-${stamp}`, "q", "m1");
    await wf.send(`hold-${stamp}`, "q", "m2");
    assert.equal(await wf.pendingCount(`hold-${stamp}`, "q"), 2);
    const peeked = await wf.drain(`hold-${stamp}`, "q");
    assert.deepEqual(peeked, ["m1", "m2"]);
    await wf.cancel(`hold-${stamp}`);

    // prune removes finished workflows older than the cutoff
    await wf.prune(["t.add"], Date.now() + 10_000);
    assert.equal(await wf.status(`add-${stamp}`), null);

    // schedules: manual run and listing
    const fired = await wf.runScheduled("t.every");
    assert.equal(fired.status, "started");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(ticks, 1);
    const scheds = await wf.schedules();
    assert.ok(scheds.some((s) => s.name === "t.every" && s.last));
  } finally {
    await wf.close();
  }
});
export { t };
