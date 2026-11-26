// Reviewer finding N4: the DBOS tests must not write into the developer's ai_collab database.
// Every DBOS test file calls this before pgUrl(): the tests (and the children they spawn, which
// inherit the environment) use ai_collab_test, created on demand.
import { ensureDatabase, pgReachable } from "../../lib/postgres.mjs";

/** Points the process (and spawned test children) at the test database; resolves true when Postgres is up. */
export async function dbosTestDb() {
  // A shell that exports the production database must not send the tests there.
  if ((process.env.AI_COLLAB_PG_DATABASE || "ai_collab") === "ai_collab" && process.env.AI_COLLAB_PG_DATABASE !== undefined) {
    throw new Error("dbos tests refuse AI_COLLAB_PG_DATABASE=ai_collab: unset it or name a test database");
  }
  process.env.AI_COLLAB_PG_DATABASE ||= "ai_collab_test";
  // The shared test database holds stale foreign-version runs from earlier test runs; the guard's own tests set it per child.
  process.env.AI_COLLAB_DBOS_VERSION_GUARD ||= "off";
  if (!(await pgReachable())) return false;
  await ensureDatabase(process.env);
  return true;
}
