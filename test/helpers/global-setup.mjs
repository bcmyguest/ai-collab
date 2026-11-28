import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDatabase, pgReachable, pgUrl } from "../../lib/postgres.ts";
import { openWorkflows } from "../../lib/workflows.ts";

// Every test dir lands in one per-run dir, so leftovers are detected and removed at teardown.
let runDir;

export async function globalSetup() {
  // A short prefix keeps Unix socket paths under the run dir within the 107-byte limit.
  runDir = mkdtempSync(path.join(os.tmpdir(), "aic-"));
  process.env.TMPDIR = runDir;
  await migrateTestDb();
}

// A fresh test database (as on CI) would have every DBOS test file run the schema migration at once, which races
// (tuple concurrently updated, deadlock, duplicate schema); create and migrate it here, once. A copy of the env leaves the tests' own unchanged.
async function migrateTestDb() {
  const env = { ...process.env, AI_COLLAB_PG_DATABASE: process.env.AI_COLLAB_PG_DATABASE || "ai_collab_test" };
  if (env.AI_COLLAB_PG_DATABASE === "ai_collab" || !(await pgReachable(env))) return;
  await ensureDatabase(env);
  // Opening the engine creates the ai_collab schema; recover() launches DBOS, which migrates the dbos schema. With no
  // workflows registered the version guard and recovery touch no run.
  const wf = await openWorkflows({ engine: "dbos", pgUrl: pgUrl(env), applicationVersion: "aic-test-setup" });
  try { await wf.recover(); } finally { await wf.close(); }
}

export async function globalTeardown() {
  const leaked = readdirSync(runDir);
  rmSync(runDir, { recursive: true, force: true });
  if (!leaked.length) return;
  const message = `test run leaked ${leaked.length} temp entries:\n${leaked.join("\n")}`;
  console.error(message);
  throw new Error(message);
}
