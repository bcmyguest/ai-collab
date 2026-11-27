// The bus store contract on Postgres, plus Postgres-only checks: NOTIFY wakeups and ids under two publishers.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { createBusServer } from "../lib/bus.mjs";
import { openPostgresBusStore } from "../lib/bus-postgres.mjs";
import { pgUrl } from "../lib/postgres.mjs";
import { pollCached, publish, streamEvents } from "../lib/transport.mjs";
import { dbosTestDb } from "./helpers/dbos-env.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const TOKEN = "tk_bus_store";
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const pgUp = await dbosTestDb();
const KINDS = ["postgres"];

async function dropSchema(schema) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: pgUrl(process.env), max: 1 });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await pool.end();
  }
}

/** Runs fn with a fresh store of `kind` behind a bus server; closes everything and drops the test schema after. */
async function withBus(kind, fn, storeOpts = {}) {
  const dir = tempDir({ after }, "ai-collab-bus-store-");
  const schema = `bus_t_${randomBytes(4).toString("hex")}`;
  const filesDir = path.join(dir, "files");
  const open = () => openPostgresBusStore({ url: pgUrl(process.env), filesDir, schema, ...storeOpts });
  const store = await open();
  const extra = [];
  const server = createBusServer({ store, token: TOKEN });
  const url = await server.listen();
  try {
    return await fn({ store, url, cfg: { url, token: TOKEN, timeoutMs: 2000 }, open2: async () => { const s = await open(); extra.push(s); return s; } });
  } finally {
    await server.close();
    for (const s of extra) await s.close();
    await store.close();
    rmSync(dir, { recursive: true, force: true });
    if (kind === "postgres") await dropSchema(schema);
  }
}

async function waitFor(check, ms) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

for (const kind of KINDS) {
  const skip = kind === "postgres" && !pgUp && "Postgres not reachable";

  test(`${kind}: since selects all, id, unknown id, and unix time`, { skip }, () => withBus(kind, async ({ cfg }) => {
    const a = await publish(cfg, "t", "a");
    await publish(cfg, "t", "b");
    assert.deepEqual((await pollCached(cfg, "t", "all")).map((e) => e.message), ["a", "b"]);
    assert.deepEqual((await pollCached(cfg, "t", a)).map((e) => e.message), ["b"]);
    assert.deepEqual((await pollCached(cfg, "t", "9999")).map((e) => e.message), ["a", "b"], "unknown id: everything");
    assert.deepEqual((await pollCached(cfg, "t", String(Math.floor(Date.now() / 1000) + 60))).map((e) => e.message), [], "future time: nothing");
  }));

  test(`${kind}: a stream backfills from since, then delivers live events for its topics only`, { skip }, () => withBus(kind, async ({ cfg }) => {
    await publish(cfg, "mine", "backlog");
    await publish(cfg, "theirs", "other topic");
    const ctrl = new AbortController();
    const got = [];
    const done = (async () => {
      try {
        for await (const ev of streamEvents(cfg, ["mine"], { since: "all", signal: ctrl.signal })) {
          got.push(`${ev.topic}:${ev.message}`);
          if (got.length === 3) ctrl.abort();
        }
      } catch { /* aborted */ }
    })();
    await new Promise((r) => setTimeout(r, 150));
    await publish(cfg, "mine", "live");
    await publish(cfg, "theirs", "ignored");
    await publish(cfg, "mine", "last");
    await done;
    assert.deepEqual(got, ["mine:backlog", "mine:live", "mine:last"]);
  }));

  test(`${kind}: files round-trip through the store`, { skip }, () => withBus(kind, async ({ store }) => {
    const saved = await store.putFile({ name: "shot.png", data: PNG });
    assert.match(saved.file, /\.png$/);
    assert.equal(saved.type, "image/png");
    const hit = await store.getFile(saved.file);
    assert.equal(hit.type, "image/png");
    assert.deepEqual(Buffer.from(hit.data), PNG);
    assert.equal(await store.getFile("nope.png"), null);
  }));

  test(`${kind}: prune removes events and files past retention`, { skip }, () => withBus(kind, async ({ store, cfg }) => {
    await publish(cfg, "t", "old");
    await store.putFile({ name: "shot.png", data: PNG });
    const later = Math.floor(Date.now() / 1000) + 8 * 86400;
    assert.deepEqual(await store.prune(later), { events: 1, files: 1 });
    assert.deepEqual(await pollCached(cfg, "t", "all"), []);
  }));
}

test("postgres: ids stay unique and ordered under two concurrent publishers", { skip: !pgUp && "Postgres not reachable" }, () => withBus("postgres", async ({ store, open2 }) => {
  const other = await open2();
  const [first, second] = await Promise.all([
    Promise.all(Array.from({ length: 40 }, (_, i) => store.publish({ topic: "t", message: `a${i}` }))),
    Promise.all(Array.from({ length: 40 }, (_, i) => other.publish({ topic: "t", message: `b${i}` }))),
  ]);
  const ids = [...first, ...second].map((e) => BigInt(e.id));
  assert.equal(new Set(ids.map(String)).size, 80, "every publish gets its own id");
  const polled = (await store.poll("t", "all")).map((e) => BigInt(e.id));
  assert.equal(polled.length, 80, "every publish is visible");
  polled.slice(1).forEach((id, i) => assert.ok(id > polled[i], `poll order breaks at ${id}`));
}));

test("postgres: a terminated backend is dropped, and the stream and publishes recover", { skip: !pgUp && "Postgres not reachable" }, () => {
  const applicationName = `bus_test_${randomBytes(4).toString("hex")}`;
  return withBus("postgres", async ({ store }) => {
    const got = [];
    const stop = await store.stream(["t"], "all", (ev) => got.push(ev.message));
    await store.publish({ topic: "t", message: "first" });
    assert.ok(await waitFor(() => got.length === 1, 2000), "stream delivers before the kill");
    const { default: pg } = await import("pg");
    const admin = new pg.Client({ connectionString: pgUrl(process.env) });
    await admin.connect();
    try {
      const { rowCount } = await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1", [applicationName]);
      assert.ok(rowCount >= 1, `expected bus backends to terminate, found ${rowCount}`);
    } finally {
      await admin.end();
    }
    await new Promise((r) => setTimeout(r, 200));
    await store.publish({ topic: "t", message: "second" });
    assert.ok(await waitFor(() => got.length === 2, 5000), "stream receives the second event within 5 s");
    assert.deepEqual(got, ["first", "second"]);
    stop();
  }, { applicationName });
});

test("postgres: NOTIFY wakes a stream on another connection, and unsubscribe stops it",{ skip: !pgUp && "Postgres not reachable" }, () => withBus("postgres", async ({ store, open2 }) => {
  const writer = await open2();
  const got = [];
  const stop = await store.stream(["t"], "all", (ev) => got.push(ev.message));
  await writer.publish({ topic: "t", message: "wake" });
  assert.ok(await waitFor(() => got.length === 1, 1000), "stream delivers within 1 s of the publish");
  assert.deepEqual(got, ["wake"]);
  stop();
  await writer.publish({ topic: "t", message: "after stop" });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(got, ["wake"], "no delivery after unsubscribe");
}));
