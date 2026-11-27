// Reviewer finding 4: a step cut by a kill must run its onCut at recovery and never re-execute,
// and replaying must be true while a recovered run replays its recorded steps.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dbosTestDb } from "./helpers/dbos-env.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "helpers", "dbos-oncut-child.mjs");
const pgUp = await dbosTestDb();

test("a step cut by a kill runs its onCut at recovery and never re-executes", { skip: pgUp ? false : "no Postgres on 127.0.0.1:5432", timeout: 120_000 }, (t) => {
  const id = `oncut-${Date.now()}`;
  const markFile = path.join(tempDir(t, "aic-oc-"), "marks.txt");
  const env = { ...process.env, SRC: path.join(HERE, ".."), AIC_DBOS_APP_VERSION: `aic-oncut-${Date.now()}` };
  const first = spawnSync(process.execPath, [CHILD, "start", id, markFile], { encoding: "utf8", timeout: 30_000, env });
  assert.equal(first.signal, "SIGKILL", "the start child must die by SIGKILL mid-step");
  assert.deepEqual(readFileSync(markFile, "utf8").trim().split("\n"), ["replaying:false", "ran"], "the fresh run enters its step with replaying false");

  const second = spawnSync(process.execPath, [CHILD, "relaunch", id, markFile], { encoding: "utf8", timeout: 60_000, env });
  assert.equal(second.status, 0, second.stderr);
  const { status, out, marks } = JSON.parse(second.stdout.trim().split("\n").pop());
  assert.equal(status, "SUCCESS", "the recovered workflow must finish");
  assert.deepEqual(out, { cut: true }, "the cut step must return its onCut value, not re-run its body");
  assert.deepEqual(marks, ["replaying:false", "ran", "replaying:true"], "the step body ran once; the recovery replays with replaying true");
});
