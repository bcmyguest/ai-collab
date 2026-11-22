// Compaction timeline text and the started-to-finished pairing; pure functions, no UI.
import test from "node:test";
import assert from "node:assert/strict";
import { compactionText, pairCompactions, tokenCount } from "../web/lib/compaction-view.js";

test("tokens read as k from 1000 up", () => {
  assert.equal(tokenCount(182000), "182k");
  assert.equal(tokenCount(31400), "31k");
  assert.equal(tokenCount(999), "999");
});

test("a finished compaction reads as the timeline sentence", () => {
  assert.equal(compactionText({ trigger: "auto", phase: "finished", tokensBefore: 182000, tokensAfter: 31000, filesDropped: 4 }),
    "Compacted · auto · 182k → 31k · 4 files dropped");
  assert.equal(compactionText({ phase: "finished", filesDropped: 1 }), "Compacted · 1 file dropped");
  assert.equal(compactionText({ trigger: "manual", phase: "started", tokensBefore: 90000 }), "Compacting · manual · 90k");
  assert.equal(compactionText({ phase: "failed", trigger: "auto", tokensBefore: 5000 }), "Compaction failed · auto · 5k");
  assert.equal(compactionText({ phase: "unknown" }), "");
});

test("a finished row takes the before count and dropped files from the started row before it", () => {
  const rows = [
    { type: "text", output: "hi" },
    { type: "compact", input: "compacting · auto", compaction: { trigger: "auto", phase: "started", tokensBefore: 182000, filesDropped: 4 } },
    { type: "compact", input: "compacted · auto", compaction: { trigger: "auto", phase: "finished" } },
  ];
  const [, , done] = pairCompactions(rows);
  assert.deepEqual(done.compaction, { trigger: "auto", phase: "finished", tokensBefore: 182000, filesDropped: 4 });
  assert.equal(compactionText(done.compaction), "Compacted · auto · 182k · 4 files dropped");
  assert.equal(rows[2].compaction.tokensBefore, undefined, "the input rows are not changed");
});

test("a finished row with its own counts keeps them, and rows without compaction pass through", () => {
  const rows = [
    { type: "compact", input: "compacting", compaction: { phase: "started", tokensBefore: 100 } },
    { type: "compact", input: "compacted", compaction: { phase: "finished", tokensBefore: 120, tokensAfter: 30 } },
  ];
  const [, done] = pairCompactions(rows);
  assert.deepEqual(done.compaction, { phase: "finished", tokensBefore: 120, tokensAfter: 30 });
  const plain = { type: "text", output: "x" };
  assert.equal(pairCompactions([plain])[0], plain);
});

test("headroom only from a reported window, never guessed", async () => {
  const { headroom, axisPercent, mapAxis } = await import("../web/lib/compaction-view.js");
  assert.deepEqual(headroom({ tokens: 182000, window: 200000 }), { left: 18000, window: 200000 });
  assert.equal(headroom({ tokens: 182000, window: null }), null);
  assert.equal(headroom({ tokens: 210000, window: 200000 }).left, 0);
  assert.equal(axisPercent(50, 0, 100), 50);
  assert.equal(axisPercent(5, 10, 10), 0);
  const now = 10 * 3600_000;
  assert.deepEqual(mapAxis([[{ at: now - 2 * 3600_000 }]], now), { start: now - 2 * 3600_000, end: now });
  assert.deepEqual(mapAxis([], now), { start: now - 3600_000, end: now });
});
