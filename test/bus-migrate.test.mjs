// ai-collab bus migrate --to postgres: the SQLite bus.db copies into the Postgres bus schema with the
// original ids, so cursors and history survive the cutover. Each test gets its own schema, dropped after.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { openPostgresBusStore } from "../lib/bus-postgres.ts";
import { migrateBusToPostgres } from "../lib/bus-migrate.ts";
import { pgUrl } from "../lib/postgres.ts";
import { dbosTestDb } from "./helpers/dbos-env.mjs";
import { openLegacyBusDb } from "./helpers/legacy-bus-db.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const pgUp = await dbosTestDb();
const skip = !pgUp && "Postgres not reachable";
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

async function pgQuery(sql, params = []) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: pgUrl(process.env), max: 1 });
  try {
    return (await pool.query(sql, params)).rows;
  } finally {
    await pool.end();
  }
}

async function dropSchema(schema) {
  await pgQuery(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
}

/** Runs fn with a temp SQLite bus dir and a fresh target schema; drops both after. */
async function withStores(fn) {
  const dir = tempDir({ after }, "bus-migrate-");
  const schema = `bus_m_${randomBytes(4).toString("hex")}`;
  const sqlite = openLegacyBusDb({ file: path.join(dir, "bus.db"), filesDir: path.join(dir, "files") });
  try {
    return await fn({ dir, schema, sqlite });
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
    await dropSchema(schema);
  }
}

const migrate = (dir, schema, opts = {}) => migrateBusToPostgres({ env: process.env, dataDir: dir, schema, ...opts });

function seedEvents(sqlite, n, from = 1) {
  for (let i = from; i < from + n; i += 1) sqlite.publish({ topic: i % 2 ? "a" : "b", message: `m${i}`, title: `t${i}` });
}

test("migrate copies events with ids, times, topics, payloads, titles and attachments", { skip }, () => withStores(async ({ dir, schema, sqlite }) => {
  seedEvents(sqlite, 3);
  const saved = sqlite.putFile({ name: "shot.png", data: PNG });
  sqlite.publish({ topic: "a", message: "with file", attachment: { name: "shot.png", type: "image/png", size: PNG.length, url: `http://bus/file/${saved.file}` } });
  const source = sqlite.poll("a", "all").concat(sqlite.poll("b", "all")).sort((x, y) => Number(x.id) - Number(y.id));

  const result = await migrate(dir, schema);
  assert.equal(result.events, 4);
  assert.equal(result.files, 1);
  assert.deepEqual([result.minId, result.maxId], [1, 4]);

  const rows = await pgQuery(`SELECT * FROM ${schema}.events ORDER BY id`);
  assert.equal(rows.length, 4);
  for (const row of rows) {
    const ev = source.find((e) => e.id === String(row.id));
    assert.ok(ev, `event ${row.id} exists in the source`);
    assert.equal(row.topic, ev.topic);
    assert.equal(Number(row.time), ev.time);
    assert.equal(row.message, ev.message);
    assert.equal(row.title, ev.title);
    assert.deepEqual(row.attachment ? JSON.parse(row.attachment) : null, ev.attachment ?? null);
  }
  const files = await pgQuery(`SELECT * FROM ${schema}.files`);
  assert.equal(files.length, 1, "the files row is copied");
  assert.equal(files[0].id, saved.file);
  assert.equal(Number(files[0].size), PNG.length);
}));

test("migrate copies more than one batch of 1000 rows", { skip }, () => withStores(async ({ dir, schema, sqlite }) => {
  seedEvents(sqlite, 1200);
  const result = await migrate(dir, schema);
  assert.equal(result.events, 1200);
  const [{ n }] = await pgQuery(`SELECT COUNT(*)::int AS n FROM ${schema}.events`);
  assert.equal(n, 1200);
}));

test("after migrate the next publish continues at max id + 1", { skip }, () => withStores(async ({ dir, schema, sqlite }) => {
  seedEvents(sqlite, 5);
  const result = await migrate(dir, schema);
  assert.equal(result.nextId, 6, "the summary reports the sequence's next value");
  const target = await openPostgresBusStore({ url: pgUrl(process.env), schema });
  try {
    const ev = await target.publish({ topic: "a", message: "after cutover" });
    assert.equal(ev.id, "6", "the sequence continues past the copied ids");
  } finally {
    await target.close();
  }
}));

test("a poll on the migrated store answers like the SQLite source", { skip }, () => withStores(async ({ dir, schema, sqlite }) => {
  seedEvents(sqlite, 4);
  const cursor = sqlite.publish({ topic: "a", message: "cursor" }).id;
  seedEvents(sqlite, 2, 6);
  await migrate(dir, schema);
  const target = await openPostgresBusStore({ url: pgUrl(process.env), schema });
  try {
    for (const topic of ["a", "b"]) {
      assert.deepEqual(await target.poll(topic, "all"), await sqlite.poll(topic, "all"), `poll all on ${topic}`);
      assert.deepEqual(await target.poll(topic, cursor), await sqlite.poll(topic, cursor), `poll since=${cursor} on ${topic}`);
    }
  } finally {
    await target.close();
  }
}));

test("migrate refuses a non-empty target unless --resume, which copies only newer ids", { skip }, () => withStores(async ({ dir, schema, sqlite }) => {
  seedEvents(sqlite, 3);
  await migrate(dir, schema);
  await assert.rejects(() => migrate(dir, schema), /already has 3 rows/);
  seedEvents(sqlite, 2, 4);
  const resumed = await migrate(dir, schema, { resume: true });
  assert.equal(resumed.events, 2, "resume copies only ids past the target's max");
  const [{ n }] = await pgQuery(`SELECT COUNT(*)::int AS n FROM ${schema}.events`);
  assert.equal(n, 5);
  const target = await openPostgresBusStore({ url: pgUrl(process.env), schema });
  try {
    const ev = await target.publish({ topic: "a", message: "next" });
    assert.equal(ev.id, "6", "the sequence continues past the resumed copy");
  } finally {
    await target.close();
  }
}));

test("running --resume twice is idempotent", { skip }, () => withStores(async ({ dir, schema, sqlite }) => {
  seedEvents(sqlite, 3);
  sqlite.putFile({ name: "shot.png", data: PNG });
  await migrate(dir, schema);
  seedEvents(sqlite, 2, 4);
  const first = await migrate(dir, schema, { resume: true });
  const second = await migrate(dir, schema, { resume: true });
  assert.equal(second.events, 0, "the second resume finds nothing new");
  assert.equal(second.files, 0, "the second resume re-copies no files rows");
  const [{ e, f }] = await pgQuery(`SELECT (SELECT COUNT(*)::int FROM ${schema}.events) AS e, (SELECT COUNT(*)::int FROM ${schema}.files) AS f`);
  assert.deepEqual({ e, f }, { e: 5, f: 1 }, "the target holds each row exactly once");
  assert.equal(first.nextId, second.nextId, "the sequence does not move on an empty resume");
}));

test("an empty source copies nothing and reports next id 1", { skip }, () => withStores(async ({ dir, schema }) => {
  const result = await migrate(dir, schema);
  assert.deepEqual({ events: result.events, files: result.files, minId: result.minId, nextId: result.nextId },
    { events: 0, files: 0, minId: 0, nextId: 1 }, "a never-used sequence already points at its first id");
}));

test("--dry-run prints the counts and writes nothing", { skip }, () => withStores(async ({ dir, schema, sqlite }) => {
  seedEvents(sqlite, 3);
  sqlite.putFile({ name: "note.txt", data: Buffer.from("hi") });
  const preview = await migrate(dir, schema, { dryRun: true });
  assert.deepEqual({ events: preview.events, files: preview.files, minId: preview.minId, maxId: preview.maxId },
    { events: 3, files: 1, minId: 1, maxId: 3 });
  const created = await pgQuery("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [schema]);
  assert.equal(created.length, 0, "dry-run did not even create the schema");
}));
