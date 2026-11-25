// A workflow killed mid-step on the DBOS engine must resume after restart without re-running finished steps.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pgReachable } from "../lib/postgres.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "helpers", "dbos-recover-child.mjs");
const pgUp = await pgReachable();

test("dbos kill-and-recover", { skip: pgUp ? false : "no Postgres on 127.0.0.1:5432", timeout: 120_000 }, () => {
  const id = `recover-${Date.now()}`;
  const markFile = path.join(mkdtempSync(path.join(tmpdir(), "aic-rec-")), "marks.txt");
  const first = spawnSync(process.execPath, [CHILD, "start", id, markFile], { encoding: "utf8", timeout: 30_000 });
  assert.ok(!first.error, `start child failed: ${first.error?.message}`);
  const killed = spawnSync("kill", ["-0", String(first.pid)]);
  assert.notEqual(killed.status, 0, "child should be gone");

  const second = spawnSync(process.execPath, [CHILD, "relaunch", id, markFile], { encoding: "utf8", timeout: 60_000 });
  assert.equal(second.status, 0, second.stderr);
  const { result, markers } = JSON.parse(second.stdout.trim().split("\n").pop());
  assert.equal(result, "ok");
  assert.deepEqual(markers, ["s1", "s2", "end"], "the finished step must not re-run");
});
