// Reviewer finding F4 (HIGH): cut detection keyed on step names alone re-runs a cut step whose name
// already completed earlier in the run (the runner repeats names in loops). Recovery must answer the
// cut occurrence with onCut, and `replaying` must not stay true past the recorded prefix (recv/sleep
// rows count in the prior operations).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dbosTestDb } from "./helpers/dbos-env.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "helpers", "dbos-loopcut-child.mjs");
const pgUp = await dbosTestDb();

test("a cut step whose name repeats in a loop runs onCut, not fn again", { skip: pgUp ? false : "no Postgres on 127.0.0.1:5432", timeout: 120_000 }, () => {
  const id = `loopcut-${Date.now()}`;
  const markFile = path.join(mkdtempSync(path.join(tmpdir(), "aic-lc-")), "marks.txt");
  const env = { ...process.env, SRC: path.join(HERE, ".."), AIC_DBOS_APP_VERSION: `aic-loopcut-${Date.now()}` };
  const first = spawnSync(process.execPath, [CHILD, "start", id, markFile], { encoding: "utf8", timeout: 30_000, env });
  assert.equal(first.signal, "SIGKILL", "the start child must die by SIGKILL mid-step");
  assert.deepEqual(readFileSync(markFile, "utf8").trim().split("\n"), ["push1 ran", "push2 ran"], "the second loop iteration was cut mid-step");

  const second = spawnSync(process.execPath, [CHILD, "relaunch", id, markFile], { encoding: "utf8", timeout: 60_000, env });
  assert.equal(second.status, 0, second.stderr);
  const { out, marks } = JSON.parse(second.stdout.trim().split("\n").pop());
  assert.deepEqual(out, ["sent1", "cut2"], "the completed occurrence replays, the cut occurrence answers onCut");
  assert.deepEqual(marks, ["push1 ran", "push2 ran", "push2 onCut replaying:false"], "fn never re-runs and replaying is false at the cut");
});
