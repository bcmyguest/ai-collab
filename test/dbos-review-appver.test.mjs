// Reviewer finding 2: the DBOS application version must not change with the workflow registration count,
// or a relaunch that registers differently orphans PENDING workflows ("No workflows to recover").
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pgReachable } from "../lib/postgres.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "helpers", "dbos-appver-child.mjs");
const pgUp = await pgReachable();

test("a pending workflow survives a relaunch that registers one more workflow", { skip: pgUp ? false : "no Postgres on 127.0.0.1:5432", timeout: 120_000 }, () => {
  const id = `appver-${Date.now()}`;
  const markFile = path.join(mkdtempSync(path.join(tmpdir(), "aic-av-")), "marks.txt");
  const env = { ...process.env, SRC: path.join(HERE, "..") };
  const first = spawnSync(process.execPath, [CHILD, "start", id, markFile], { encoding: "utf8", timeout: 30_000, env });
  assert.equal(first.signal, "SIGKILL", "the start child must die by SIGKILL mid-step");
  assert.deepEqual(readFileSync(markFile, "utf8").trim().split("\n"), ["entered"], "the workflow entered its long step before the kill");

  const second = spawnSync(process.execPath, [CHILD, "relaunch", id, markFile, "1"], { encoding: "utf8", timeout: 60_000, env });
  assert.equal(second.status, 0, second.stderr);
  const { status, marks } = JSON.parse(second.stdout.trim().split("\n").pop());
  assert.equal(status, "SUCCESS", "the pending workflow must be recovered and finish, not be orphaned");
  assert.deepEqual(marks, ["entered", "entered"], "the unfinished step re-runs once on recovery");
});
