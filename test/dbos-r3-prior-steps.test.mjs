// r3 B: the prior-steps lookup must fail closed. A query error used to read as "no prior record", so a cut
// wake.send re-ran its fn and sent the harness a second turn. It retries with backoff, then parks the run
// PENDING (DBOS records any thrown error as a terminal ERROR) so the next boot recovers it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readPriorSteps } from "../lib/workflows.ts";
import { dbosTestDb } from "./helpers/dbos-env.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "helpers", "dbos-r3-prior-child.mjs");

const pgUp = await dbosTestDb();

test("readPriorSteps retries a failing query, then succeeds", async () => {
  let calls = 0;
  const query = async () => {
    calls += 1;
    if (calls < 3) throw new Error("connection reset");
    return { rows: [{ function_name: "a!started" }, { function_name: "a" }] };
  };
  assert.deepEqual(await readPriorSteps(query, "w1", { delayMs: 1 }), ["a!started", "a"]);
  assert.equal(calls, 3);
});

test("readPriorSteps throws after its attempts instead of reporting no prior record", async () => {
  let calls = 0;
  const query = async () => { calls += 1; throw new Error("connection reset"); };
  await assert.rejects(readPriorSteps(query, "w1", { attempts: 4, delayMs: 1 }), /prior steps of w1 unreadable after 4 attempts: connection reset/);
  assert.equal(calls, 4);
});

test("an unreadable prior-step record parks the run PENDING and the next boot recovers it", { skip: pgUp ? false : "no Postgres on 127.0.0.1:5432", timeout: 90_000 }, () => {
  const stamp = Date.now();
  const id = `r3b-${stamp}`;
  const env = { ...process.env, SRC: path.join(HERE, ".."), AIC_DBOS_APP_VERSION: `aic-r3b-${stamp}` };
  const run = (phase) => {
    const r = spawnSync(process.execPath, [CHILD, phase, id], { encoding: "utf8", timeout: 60_000, env });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split("\n").pop());
  };
  assert.deepEqual(run("broken"), { started: true, ran: 0, status: "PENDING" }, "the body must not run without its prior-step record, and the run stays PENDING, not ERROR");
  assert.deepEqual(run("healthy"), { ran: 1, out: "done" }, "the next boot recovers and finishes the parked run");
});
