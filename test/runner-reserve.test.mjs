import test from "node:test";
import assert from "node:assert/strict";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { setup } from "./helpers/runner-ctx.mjs";
import { releaseOwned, reserveOwned } from "../lib/inbox.mjs";

test("a workflow owner re-acquires its own reservation after a restart; another owner gets nothing until release", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  try {
    const cfg = ctx.cfg;
    assert.deepEqual(await reserveOwned(cfg, ["r1"], { owner: "w1" }), { owned: ["r1"], busy: false });
    assert.deepEqual(await reserveOwned(cfg, ["r1"], { owner: "w2" }), { owned: [], busy: false });
    // The same owner again, as after a restart: the reservation is its own.
    assert.deepEqual(await reserveOwned(cfg, ["r1"], { owner: "w1" }), { owned: ["r1"], busy: false });
    await releaseOwned(cfg, ["r1"], "w2");
    assert.deepEqual(await reserveOwned(cfg, ["r1"], { owner: "w2" }), { owned: [], busy: false }, "another owner's release does not drop it");
    await releaseOwned(cfg, ["r1"], "w1");
    assert.deepEqual(await reserveOwned(cfg, ["r1"], { owner: "w2" }), { owned: ["r1"], busy: false });
  } finally {
    await fake.close();
  }
});

test("a reservation that has expired is taken by the next owner", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  try {
    await reserveOwned(ctx.cfg, ["r2"], { owner: "w1", ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(await reserveOwned(ctx.cfg, ["r2"], { owner: "w2" }), { owned: ["r2"], busy: false });
  } finally {
    await fake.close();
  }
});
