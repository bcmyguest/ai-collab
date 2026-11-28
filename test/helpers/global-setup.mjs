import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDatabase, pgReachable, pgUrl } from "../../lib/postgres.ts";

// Every test dir lands in one per-run dir, so leftovers are detected and removed at teardown.
let runDir;

export async function globalSetup() {
  // A short prefix keeps Unix socket paths under the run dir within the 107-byte limit.
  runDir = mkdtempSync(path.join(os.tmpdir(), "aic-"));
  process.env.TMPDIR = runDir;
  await migrateTestDb();
}

// A fresh test database (as on CI) would have every DBOS test file run the schema migration at once, which races
// (tuple concurrently updated, deadlock); create and migrate it here, once. A copy of the env leaves the tests' own unchanged.
async function migrateTestDb() {
  const env = { ...process.env, AI_COLLAB_PG_DATABASE: process.env.AI_COLLAB_PG_DATABASE || "ai_collab_test" };
  if (env.AI_COLLAB_PG_DATABASE === "ai_collab" || !(await pgReachable(env))) return;
  await ensureDatabase(env);
  const { DBOS } = await import("@dbos-inc/dbos-sdk");
  DBOS.setConfig({ name: "ai-collab-test-setup", systemDatabaseUrl: pgUrl(env) });
  await DBOS.launch();
  await DBOS.shutdown();
}

export async function globalTeardown() {
  const leaked = readdirSync(runDir);
  rmSync(runDir, { recursive: true, force: true });
  if (!leaked.length) return;
  const message = `test run leaked ${leaked.length} temp entries:\n${leaked.join("\n")}`;
  console.error(message);
  throw new Error(message);
}
