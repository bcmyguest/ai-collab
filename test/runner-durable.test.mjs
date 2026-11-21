import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDurable, NonDeterminismError } from "../runner/durable.mjs";

const dbFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), "ai-collab-durable-")), "runner.db");

test("a completed step replays its recorded output instead of running again", async () => {
  const file = dbFile();
  let runs = 0;
  const flow = async (wf) => {
    const a = await wf.step("a", async () => { runs += 1; return { n: runs }; });
    const msg = await wf.recv("go");
    return { a, msg };
  };
  const first = openDurable(file);
  first.register("flow", flow);
  first.startWorkflow("flow", "w1", {});
  await new Promise((r) => setTimeout(r, 20));
  await first.close();
  assert.equal(runs, 1);

  const second = openDurable(file);
  second.register("flow", flow);
  assert.deepEqual(second.recover(), ["w1"]);
  second.send("w1", "go", "now");
  assert.deepEqual(await second.result("w1"), { a: { n: 1 }, msg: "now" });
  assert.equal(runs, 1);
  assert.equal(second.status("w1").status, "SUCCESS");
  await second.close();
});

test("a step cut by a close runs its onCut once at recovery and never re-executes", async () => {
  const file = dbFile();
  let sends = 0;
  let cuts = 0;
  const flow = async (wf) => wf.step("send", async () => {
    sends += 1;
    await new Promise((_, reject) => wf.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  }, { onCut: async () => { cuts += 1; return { cut: true }; } });
  const first = openDurable(file);
  first.register("flow", flow);
  first.startWorkflow("flow", "w1", {});
  await new Promise((r) => setTimeout(r, 20));
  await first.close();

  const second = openDurable(file);
  second.register("flow", flow);
  second.recover();
  assert.deepEqual(await second.result("w1"), { cut: true });
  assert.deepEqual([sends, cuts], [1, 1]);
  await second.close();
});

test("recv consumes durable messages in order, drops a repeated dedupe key, and all takes the backlog", async () => {
  const log = openDurable(":memory:");
  log.register("flow", async (wf) => [await wf.recv("in"), await wf.recv("in", { all: true })]);
  assert.equal(log.send("w", "in", 1, { dedupe: "ntfy:a" }), true);
  assert.equal(log.send("w", "in", 1, { dedupe: "ntfy:a" }), false);
  log.send("w", "in", 2);
  log.send("w", "in", 3);
  const out = await log.startWorkflow("flow", "w", {});
  assert.deepEqual(out, [1, [2, 3]]);
  await log.close();
});

test("a changed step order at replay throws NonDeterminismError", async () => {
  const file = dbFile();
  const first = openDurable(file);
  first.register("flow", async (wf) => { await wf.step("a", async () => 1); await wf.recv("x"); });
  first.startWorkflow("flow", "w", {});
  await new Promise((r) => setTimeout(r, 20));
  await first.close();
  const second = openDurable(file);
  second.register("flow", async (wf) => wf.step("b", async () => 2));
  second.recover();
  await assert.rejects(second.result("w"), NonDeterminismError);
  await second.close();
});

test("kv keeps a value across opens", async () => {
  const file = dbFile();
  const first = openDurable(file);
  first.setKv("ntfy-cursor:demo", "m00000007");
  await first.close();
  const second = openDurable(file);
  assert.equal(second.getKv("ntfy-cursor:demo"), "m00000007");
  await second.close();
});
