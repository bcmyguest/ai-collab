// r3 review R1: a graceful close (runner restart) aborts the context signal. On DBOS the run that unwound on it
// was recorded as a terminal ERROR, and a step that rejected on it recorded its error, so the restart lost every
// in-flight session, wake, delivery and tick. Like the sqlite engine, close must leave them PENDING with the
// step cut: the next boot recovers the run and answers the cut step with its onCut.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dbosTestDb } from "./helpers/dbos-env.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "helpers", "dbos-r3-close-child.mjs");
const pgUp = await dbosTestDb();

test("a graceful close leaves signal-aware runs PENDING with their step cut, and the next boot recovers them", { skip: pgUp ? false : "no Postgres on 127.0.0.1:5432", timeout: 120_000 }, () => {
  const stamp = String(Date.now());
  const env = { ...process.env, SRC: path.join(HERE, ".."), AIC_DBOS_APP_VERSION: `aic-r3r-${stamp}` };
  const run = (phase) => {
    const r = spawnSync(process.execPath, [CHILD, phase, stamp], { encoding: "utf8", timeout: 60_000, env });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split("\n").pop());
  };
  assert.deepEqual(run("close"), { bodies: 1 });
  assert.deepEqual(run("relaunch"), { bodies: 0, out: { pause: "resumed", step: "cut" } }, "both runs recover; the cut step answers with onCut and never re-runs");
});
