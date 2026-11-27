// Repro: after a restart, >100 newer delivery rows push older undelivered ones out of the seed; they fill CLAIM_LIMIT.
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
const SRC = process.env.SRC || new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const { sessionLabel } = await import(`${SRC}/lib/config.ts`);
const { recordSession } = await import(`${SRC}/lib/sessions.mjs`);
const { openDurable } = await import(`${SRC}/runner/durable.mjs`);
const { startFakeNtfy } = await import(`${SRC}/test/helpers/fake-ntfy.mjs`);
const { makeRunner, procStart, setup } = await import(`${SRC}/test/helpers/runner-ctx.mjs`);

test("an undelivered message beyond the newest 100 delivery rows starves the session", async () => {
  const fake = await startFakeNtfy();
  try {
    const ctx = setup(fake);
    const nid = randomUUID();
    const label = sessionLabel(nid);
    await recordSession({ ...ctx.cfg, peer: "claude", session: label }, { id: nid, cwd: ctx.root, harness: "claude", event: "stop", proc: { pid: process.pid, start: procStart(process.pid) } });
    const address = `claude#${label}`;
    const msgs = [0, 1, 2, 3, 4].map((i) => ({ id: `m${i}`, from: "codex", to: address, priority: "normal", text: `t${i}` }));
    // Earlier process: m0..m3 got delivery workflows that ended "cut" (message never marked delivered).
    let t = 1000;
    const old = openDurable(ctx.db, { now: () => t++ });
    old.register("delivery", async () => ({ status: "cut" }));
    for (const m of msgs.slice(0, 4)) await old.startWorkflowOnce("delivery", `delivery:${address}:${m.id}`, {});
    t = 5000;
    for (let i = 0; i < 100; i++) await old.startWorkflowOnce("delivery", `delivery:other#x:${i}`, {});
    await old.close();

    const claimed = [];
    const claim = async (_cfg, opts) => { const out = msgs.filter(opts.accept).slice(0, opts.limit); claimed.push(out.map((m) => m.id)); return out; };
    const { runner, durable } = makeRunner(ctx, [], { delivery: { claim, sessionOf: () => null } });
    await runner.boot();
    const first = await runner.pump();
    const second = await runner.pump();
    console.log("claims", JSON.stringify(claimed), "started", JSON.stringify([first, second]));
    assert.ok([...first, ...second].includes(`delivery:${address}:m4`), "m4 must get a delivery workflow");
    await runner.stop?.();
    await durable.close?.();
  } finally {
    await fake.close();
  }
});
