// A failed openPostgresBusStore must leave no connection or reconnect timer that keeps the process alive.
// A local proxy in front of the test database answers chosen connections with "too many clients" (53300).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { test } from "node:test";
import { openPostgresBusStore } from "../lib/bus-postgres.ts";
import { pgUrl } from "../lib/postgres.ts";
import { dbosTestDb } from "./helpers/dbos-env.mjs";

const pgUp = await dbosTestDb();
const skip = !pgUp && "Postgres not reachable";
// Longer than the store's 1 s listener reconnect delay.
const RECONNECT_WAIT_MS = 1500;

function errorResponse(message) {
  const fields = Buffer.concat([...[["S", "FATAL"], ["V", "FATAL"], ["C", "53300"], ["M", message]].map(([k, v]) => Buffer.from(`${k}${v}\0`)), Buffer.from([0])]);
  const head = Buffer.alloc(5);
  head.write("E");
  head.writeInt32BE(fields.length + 4, 1);
  return Buffer.concat([head, fields]);
}

/** Proxies to the test database; connection numbers in `reject` (1-based) get "too many clients". */
async function startProxy(reject) {
  const target = Number(process.env.AI_COLLAB_PG_PORT || "5432");
  const host = process.env.AI_COLLAB_PG_HOST || "127.0.0.1";
  const sockets = new Set();
  const proxy = { accepted: 0, open: () => sockets.size };
  const server = net.createServer((c) => {
    proxy.accepted += 1;
    sockets.add(c);
    c.on("close", () => sockets.delete(c));
    c.on("error", () => {});
    if (reject.includes(proxy.accepted)) {
      c.once("data", () => c.end(errorResponse("sorry, too many clients already")));
      return;
    }
    const up = net.connect(target, host);
    c.pipe(up).pipe(c);
    c.on("close", () => up.destroy());
    up.on("error", () => c.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy.port = server.address().port;
  proxy.close = () => {
    for (const c of sockets) c.destroy();
    return new Promise((resolve) => server.close(resolve));
  };
  return proxy;
}

async function dropSchema(schema) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: pgUrl(process.env), max: 1 });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await pool.end();
  }
}

/** Opens a store through a proxy that rejects connection `n`; returns the proxy after the reconnect delay. */
async function openThroughRejection(n) {
  const proxy = await startProxy([n]);
  const schema = `bus_of_${randomBytes(4).toString("hex")}`;
  try {
    const url = pgUrl({ ...process.env, AI_COLLAB_PG_PORT: String(proxy.port) });
    await assert.rejects(openPostgresBusStore({ url, schema }), /too many clients/);
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_WAIT_MS));
    return { accepted: proxy.accepted, open: proxy.open() };
  } finally {
    await proxy.close();
    await dropSchema(schema);
  }
}

test("a refused migrate connection leaves no connection open", { skip }, async () => {
  assert.deepEqual(await openThroughRejection(1), { accepted: 1, open: 0 });
});

test("a refused LISTEN connection closes the pool and schedules no reconnect", { skip }, async () => {
  assert.deepEqual(await openThroughRejection(2), { accepted: 2, open: 0 });
});

test("close twice resolves both times", { skip }, async () => {
  const schema = `bus_of_${randomBytes(4).toString("hex")}`;
  try {
    const store = await openPostgresBusStore({ url: pgUrl(process.env), schema });
    await Promise.all([store.close(), store.close()]);
    await store.close();
  } finally {
    await dropSchema(schema);
  }
});
