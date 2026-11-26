// Reviewer finding N4: the DBOS tests write into the developer's ai_collab database. pgUrl must honour
// AI_COLLAB_PG_DATABASE so tests (and the children they spawn) point at ai_collab_test, and
// ensureDatabase must create that database when it is missing.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureDatabase, pgReachable, pgUrl } from "../lib/postgres.mjs";

test("pgUrl honours AI_COLLAB_PG_DATABASE and defaults to ai_collab", () => {
  const pw = path.join(mkdtempSync(path.join(os.tmpdir(), "aic-pgurl-")), "pg-password");
  writeFileSync(pw, "test-password");
  assert.match(pgUrl({ AI_COLLAB_PG_PASSWORD_FILE: pw }), /\/ai_collab$/);
  assert.match(
    pgUrl({ AI_COLLAB_PG_PASSWORD_FILE: pw, AI_COLLAB_PG_DATABASE: "ai_collab_test" }),
    /\/ai_collab_test$/);
});

test("ensureDatabase creates a missing database and is idempotent", { skip: (await pgReachable()) ? false : "no Postgres on 127.0.0.1:5432", timeout: 60_000 }, async () => {
  const name = `aic_memtest_${Date.now()}`;
  await ensureDatabase({ AI_COLLAB_PG_DATABASE: name });
  await ensureDatabase({ AI_COLLAB_PG_DATABASE: name }); // second call must not throw
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: pgUrl({ AI_COLLAB_PG_DATABASE: name }) });
  try {
    const { rows } = await pool.query("SELECT current_database() AS db");
    assert.equal(rows[0].db, name);
  } finally {
    await pool.end();
    const admin = new pg.Pool({ connectionString: pgUrl() });
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  }
});
