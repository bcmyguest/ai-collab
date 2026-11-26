// r3 C: `replaying` is true exactly while a recovered run re-issues recorded ops. It drifted: a blocking recv
// writes 2 rows (DBOS.recv plus a DBOS.sleep deadline) but counted 1, a zero sleep writes none but counted 1,
// and a workflow started from a workflow body wrote rows nothing counted.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dbosTestDb } from "./helpers/dbos-env.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "helpers", "dbos-r3-replay-child.mjs");
const pgUp = await dbosTestDb();

test("replaying turns false where the recorded ops end, after blocking recvs, a zero sleep and a late handoff", { skip: pgUp ? false : "no Postgres on 127.0.0.1:5432", timeout: 120_000 }, () => {
  const stamp = Date.now();
  const markFile = path.join(mkdtempSync(path.join(tmpdir(), "aic-r3c-")), "marks.txt");
  const env = { ...process.env, SRC: path.join(HERE, ".."), AIC_DBOS_APP_VERSION: `aic-r3c-${stamp}` };
  const first = spawnSync(process.execPath, [CHILD, "start", String(stamp), markFile], { encoding: "utf8", timeout: 30_000, env });
  assert.equal(first.signal, "SIGKILL", first.stderr);
  const second = spawnSync(process.execPath, [CHILD, "relaunch", String(stamp), markFile], { encoding: "utf8", timeout: 60_000, env });
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout.trim().split("\n").pop()), { recv: "done", sleep0: "done" });
  const marks = readFileSync(markFile, "utf8").trim().split("\n").filter((m) => m.startsWith("relaunch:")).sort();
  assert.deepEqual(marks, [
    "relaunch: recv after b replaying=true got=hello+two",
    "relaunch: recv after c replaying=false",
    "relaunch: recv before c replaying=true",
    "relaunch: recv c onCut replaying=false",
    "relaunch: sleep0 before c replaying=true",
    "relaunch: sleep0 c onCut replaying=false",
  ]);
});
