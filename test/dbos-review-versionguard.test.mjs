// Reviewer finding 2: a deliberate application-version bump silently orphans old PENDING runs (DBOS only
// recovers its own version). The boot guard reads AI_COLLAB_DBOS_VERSION_GUARD: off (default, shared dev
// databases and parallel tests hold stale rows), refuse (boot fails listing foreign-version runs of our
// own workflows), drain (cancel them, then boot).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dbosTestDb } from "./helpers/dbos-env.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "helpers", "dbos-versionguard-child.mjs");
const pgUp = await dbosTestDb();
const stamp = Date.now();
const OLD = `aic-vg-old-${stamp}`;
const NEW = `aic-vg-new-${stamp}`;

function run(phase, id, version, guard) {
  const env = { ...process.env, SRC: path.join(HERE, ".."), AIC_DBOS_APP_VERSION: version };
  if (guard) env.AI_COLLAB_DBOS_VERSION_GUARD = guard;
  return spawnSync(process.execPath, [CHILD, phase, id], { encoding: "utf8", timeout: 60_000, env });
}

function report(child) {
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim().split("\n").pop());
}

function orphan(id, version) {
  const r = run("orphan", id, version);
  assert.equal(r.signal, "SIGKILL", "the orphan child must die by SIGKILL with its run PENDING");
}

const opts = { skip: pgUp ? false : "no Postgres on 127.0.0.1:5432", timeout: 150_000 };

test("refuse: a version bump with foreign PENDING runs refuses to boot", opts, () => {
  const id = `vg-refuse-${stamp}`;
  orphan(id, OLD);
  const { error } = report(run("check", id, NEW, "refuse"));
  assert.ok(error, "the guard must refuse the boot");
  assert.match(error, new RegExp(id));
});

test("drain: a version bump cancels the foreign PENDING runs and boots", opts, () => {
  const id = `vg-drain-${stamp}`;
  orphan(id, OLD);
  const { error, status } = report(run("check", id, NEW, "drain"));
  assert.equal(error, null, "drain must boot");
  assert.equal(status, "CANCELLED", "the foreign-version run is cancelled, not left orphaned");
});

test("off (default): foreign PENDING runs are left alone", opts, () => {
  const id = `vg-off-${stamp}`;
  orphan(id, OLD);
  const { error, status } = report(run("check", id, NEW));
  assert.equal(error, null, "the default boot is unchanged");
  assert.equal(status, "PENDING", "with the guard off nothing is cancelled");
});
