// Reviewer finding N4: the DBOS tests must not write into the developer's ai_collab database.
// Every DBOS test file calls this before pgUrl(): the tests (and the children they spawn, which
// inherit the environment) use ai_collab_test, created on demand.
import { ensureDatabase, pgReachable } from "../../lib/postgres.mjs";

/** Points the process (and spawned test children) at the test database; resolves true when Postgres is up. */
export async function dbosTestDb() {
  process.env.AI_COLLAB_PG_DATABASE ||= "ai_collab_test";
  if (!(await pgReachable())) return false;
  await ensureDatabase(process.env);
  return true;
}
