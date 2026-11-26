// r3 A, D, E: the dbos engine refuses by default to boot over foreign-version PENDING runs and lists every one;
// the test helper turns the guard off for the suite and refuses to point the tests at the ai_collab database.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dbosTestDb } from "./helpers/dbos-env.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "helpers", "dbos-r3-guard-child.mjs");
const pgUp = await dbosTestDb();
const stamp = Date.now();
const opts = { skip: pgUp ? false : "no Postgres on 127.0.0.1:5432", timeout: 240_000 };

function run(phase, id, version, env = {}) {
  const childEnv = { ...process.env, SRC: path.join(HERE, ".."), AIC_DBOS_APP_VERSION: version, ...env };
  for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k];
  return spawnSync(process.execPath, [CHILD, phase, id], { encoding: "utf8", timeout: 60_000, env: childEnv });
}

test("dbosTestDb turns the version guard off and keeps the test database", { skip: opts.skip }, () => {
  assert.equal(process.env.AI_COLLAB_DBOS_VERSION_GUARD, "off");
  assert.equal(process.env.AI_COLLAB_PG_DATABASE, "ai_collab_test");
});

test("dbosTestDb refuses to run the tests against the ai_collab database", () => {
  const helper = path.join(HERE, "helpers", "dbos-env.mjs");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const { dbosTestDb } = await import(${JSON.stringify(helper)}); await dbosTestDb(); console.log("ran");`],
    { encoding: "utf8", timeout: 30_000, env: { ...process.env, AI_COLLAB_PG_DATABASE: "ai_collab" } });
  assert.notEqual(r.status, 0, "the helper must refuse the production database");
  assert.doesNotMatch(r.stdout, /ran/);
  assert.match(r.stderr, /ai_collab/);
});

test("the dbos engine refuses by default to boot over foreign-version PENDING runs, listing every id", opts, () => {
  const old = `aic-r3g-old-${stamp}`;
  const ids = Array.from({ length: 6 }, (_, i) => `r3g-${stamp}-${i}`);
  for (const id of ids) assert.equal(run("orphan", id, old).signal, "SIGKILL", "the orphan child must die with its run PENDING");
  const r = run("check", ids[0], `aic-r3g-new-${stamp}`, { AI_COLLAB_DBOS_VERSION_GUARD: undefined });
  assert.equal(r.status, 0, r.stderr);
  const { error } = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.ok(error, "with no AI_COLLAB_DBOS_VERSION_GUARD the dbos engine must refuse");
  for (const id of ids) assert.match(error, new RegExp(id), `the refusal must list ${id}: ${error}`);
  // Leave nothing PENDING for other test files: drain the orphans.
  assert.equal(run("check", ids[0], `aic-r3g-new-${stamp}`, { AI_COLLAB_DBOS_VERSION_GUARD: "drain" }).status, 0);
});
