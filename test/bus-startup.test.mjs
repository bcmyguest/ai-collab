// The bus runs on Postgres only: the store switch refuses sqlite, a missing Postgres stops the start with a
// pointer at `ai-collab postgres up`, and a leftover bus.db beside an empty store refuses the start.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { after, test } from "node:test";
import { resolveBusStoreKind } from "../lib/bus.ts";
import { openPostgresBusStore } from "../lib/bus-postgres.ts";
import { pgUrl } from "../lib/postgres.ts";
import { legacyBusDb, main } from "../scripts/ai-collab-bus.mjs";
import { dbosTestDb } from "./helpers/dbos-env.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const pgUp = await dbosTestDb();

/** An env rooted in a temp dir: no defaults.json, its own state dir and Postgres password file. */
function isolatedEnv(t, extra = {}) {
  const dir = tempDir(t, "bus-startup-");
  return {
    dir,
    env: {
      HOME: dir,
      XDG_CONFIG_HOME: path.join(dir, "config"),
      AI_COLLAB_STATE_DIR: path.join(dir, "state"),
      AI_COLLAB_BUS_TOKEN: "tk_bus_startup",
      AI_COLLAB_PG_PASSWORD_FILE: path.join(dir, "pg-password"),
      ...extra,
    },
  };
}

async function runMain(env) {
  let text = "";
  const code = await main(env, { err: { write: (s) => { text += s; } } });
  return { code, text };
}

/** A loopback port nothing listens on. */
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("resolveBusStoreKind defaults to postgres and refuses the retired sqlite store", () => {
  assert.equal(resolveBusStoreKind({}, {}), "postgres");
  assert.equal(resolveBusStoreKind({}, { busStore: "postgres" }), "postgres");
  assert.throws(() => resolveBusStoreKind({ AI_COLLAB_BUS_STORE: "sqlite" }, {}), /retired.*ai-collab bus migrate --to postgres/);
  assert.throws(() => resolveBusStoreKind({}, { busStore: "sqlite" }), /retired/);
  assert.throws(() => resolveBusStoreKind({ AI_COLLAB_BUS_STORE: "redis" }, {}), /unknown store redis/);
});

test("the bus refuses to start with busStore sqlite", async (t) => {
  const { env } = isolatedEnv(t, { AI_COLLAB_BUS_STORE: "sqlite" });
  const { code, text } = await runMain(env);
  assert.equal(code, 1);
  assert.match(text, /SQLite store \(bus\.db\) is retired/);
});

test("the bus refuses to start without a Postgres password and points at ai-collab postgres up", async (t) => {
  const { env } = isolatedEnv(t);
  const { code, text } = await runMain(env);
  assert.equal(code, 1);
  assert.match(text, /no Postgres password at .*pg-password.*run `ai-collab postgres up`/);
});

test("the bus refuses to start when Postgres is unreachable and points at ai-collab postgres up", async (t) => {
  const port = await closedPort();
  const { env } = isolatedEnv(t, { AI_COLLAB_PG_PORT: String(port) });
  writeFileSync(env.AI_COLLAB_PG_PASSWORD_FILE, "pw", { mode: 0o600 });
  const { code, text } = await runMain(env);
  assert.equal(code, 1);
  assert.match(text, new RegExp(`no Postgres on 127\\.0\\.0\\.1:${port}.*run \`ai-collab postgres up\``));
});

test("legacyBusDb: no file passes, a file beside an empty store refuses, beside a filled store warns", async (t) => {
  const dir = tempDir(t, "bus-legacy-");
  const empty = { isEmpty: async () => true };
  const filled = { isEmpty: async () => false };
  assert.deepEqual(await legacyBusDb({ dataDir: dir, store: empty }), { refuse: false, message: "" });
  writeFileSync(path.join(dir, "bus.db"), "");
  const refused = await legacyBusDb({ dataDir: dir, store: empty });
  assert.equal(refused.refuse, true);
  assert.match(refused.message, /ai-collab bus migrate --to postgres/);
  const warned = await legacyBusDb({ dataDir: dir, store: filled });
  assert.equal(warned.refuse, false);
  assert.match(warned.message, /retired SQLite store/);
});

test("postgres store isEmpty turns false after the first publish", { skip: !pgUp && "Postgres not reachable" }, async () => {
  const schema = `bus_su_${randomBytes(4).toString("hex")}`;
  const store = await openPostgresBusStore({ url: pgUrl(process.env), schema });
  after(async () => {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: pgUrl(process.env), max: 1 });
    try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await pool.end(); }
  });
  try {
    assert.equal(await store.isEmpty(), true);
    await store.publish({ topic: "t", message: "m" });
    assert.equal(await store.isEmpty(), false);
  } finally {
    await store.close();
  }
});
