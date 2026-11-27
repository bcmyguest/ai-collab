// Unknown-cursor contract for the bus (4b batch 3): when `since` names an event the store cannot place —
// pruned, newer than everything, not an id, or from another bus — the server replays from the oldest
// retained event and says so with reset: true in the poll JSON and in the first stream line.
// Each case runs on Postgres (test/bus-store.test.mjs pattern); docs/research/bus-unknown-cursor.md.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { createBusServer } from "../lib/bus.mjs";
import { openPostgresBusStore } from "../lib/bus-postgres.mjs";
import { pgUrl } from "../lib/postgres.mjs";
import { dbosTestDb } from "./helpers/dbos-env.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const TOKEN = "tk_unknown_cursor";
const RETENTION_MS = 3_600_000;
const STREAM_QUIET_MS = 400;
const KINDS = ["postgres"];
const pgUp = await dbosTestDb();

async function dropSchema(schema) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: pgUrl(process.env), max: 1 });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await pool.end();
  }
}

async function openBusTmp(kind) {
  const dir = tempDir({ after }, "bus-unknown-cursor-");
  const filesDir = path.join(dir, "files");
  const schema = `bus_uc_${randomBytes(4).toString("hex")}`;
  const store = await openPostgresBusStore({ url: pgUrl(process.env), filesDir, schema, retentionMs: RETENTION_MS });
  const server = createBusServer({ store, token: TOKEN });
  const url = await server.listen(0);
  return {
    store,
    url,
    publish: async (topic, message) => {
      const res = await fetch(`${url}/`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ topic, message }),
      });
      assert.equal(res.status, 200, `publish ${message} failed`);
      return (await res.json()).id;
    },
    close: async () => {
      await server.close();
      await store.close();
      fs.rmSync(dir, { recursive: true, force: true });
      if (kind === "postgres") await dropSchema(schema);
    },
  };
}

// Raw poll lines, not pollCached: messageEvent drops fields it does not model, reset included (lib/transport.mjs:161,168).
async function pollLines(bus, topic, since) {
  const res = await fetch(`${bus.url}/${encodeURIComponent(topic)}/json?poll=1&since=${encodeURIComponent(since)}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 200);
  return (await res.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((ev) => ev.event === "message");
}

// Raw stream lines: read until expect message events arrive or the stream goes quiet, then abort.
async function streamLines(bus, topics, since, expect) {
  const ctrl = new AbortController();
  try {
    const res = await fetch(`${bus.url}/${topics.map(encodeURIComponent).join(",")}/json?since=${encodeURIComponent(since)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: ctrl.signal,
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const quiet = new Promise((resolve) => setTimeout(resolve, STREAM_QUIET_MS, "quiet"));
      const chunk = await Promise.race([reader.read(), quiet]);
      if (chunk === "quiet" || chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      const complete = text.slice(0, text.lastIndexOf("\n") + 1);
      if (complete.split("\n").filter((line) => line && JSON.parse(line).event === "message").length >= expect) break;
    }
    return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } finally {
    ctrl.abort();
  }
}

const messageIds = (lines) => lines.filter((ev) => ev.event === "message").map((ev) => ev.id);

// The contract each case must satisfy: poll replays the retained ids oldest-first with reset: true,
// and the stream's first line carries reset: true over the same replay.
async function assertReplayWithReset(bus, topic, since, retainedIds) {
  const polled = await pollLines(bus, topic, since);
  assert.deepEqual(polled.map((ev) => ev.id), retainedIds, `poll since=${since} must replay from the oldest retained event`);
  assert.equal(polled[0]?.reset, true, `poll since=${since} must carry reset: true in its JSON`);
  const streamed = await streamLines(bus, [topic], since, retainedIds.length);
  assert.equal(streamed[0]?.reset, true, `stream since=${since} must carry reset: true in the first line`);
  assert.deepEqual(messageIds(streamed), retainedIds, `stream since=${since} must replay from the oldest retained event`);
}

for (const kind of KINDS) {
  const skip = kind === "postgres" && !pgUp && "Postgres not reachable";

  test(`${kind}: a pruned cursor replays from the oldest retained event with reset`, { skip }, async () => {
    const bus = await openBusTmp(kind);
    try {
      const early = [];
      for (const m of ["e1", "e2", "e3"]) early.push(await bus.publish("cur", m));
      await bus.store.prune(Math.floor(Date.now() / 1000) + Math.floor(RETENTION_MS / 1000) + 60);
      const retained = [];
      for (const m of ["e4", "e5"]) retained.push(await bus.publish("cur", m));
      await assertReplayWithReset(bus, "cur", early[1], retained);
    } finally {
      await bus.close();
    }
  });

  test(`${kind}: a cursor newer than every event replays the whole topic with reset`, { skip }, async () => {
    const bus = await openBusTmp(kind);
    try {
      const ids = [];
      for (const m of ["e1", "e2", "e3", "e4", "e5"]) ids.push(await bus.publish("cur", m));
      await assertReplayWithReset(bus, "cur", String(Number(ids.at(-1)) + 1000), ids);
    } finally {
      await bus.close();
    }
  });

  test(`${kind}: a garbage cursor replays the whole topic with reset`, { skip }, async () => {
    const bus = await openBusTmp(kind);
    try {
      const ids = [];
      for (const m of ["e1", "e2", "e3", "e4", "e5"]) ids.push(await bus.publish("cur", m));
      await assertReplayWithReset(bus, "cur", "not-a-cursor", ids);
    } finally {
      await bus.close();
    }
  });

  test(`${kind}: a cursor from another bus replays this bus from the oldest event with reset`, { skip }, async () => {
    const bus = await openBusTmp(kind);
    const foreign = await openBusTmp(kind);
    try {
      const ids = [];
      for (const m of ["e1", "e2", "e3", "e4", "e5"]) ids.push(await bus.publish("cur", m));
      let foreignId = "";
      for (const m of ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"]) foreignId = await foreign.publish("cur", m);
      // foreignId is the foreign bus's 8th id, above this bus's newest (5), so it cannot collide with a retained id.
      // A foreign id equal to a retained local id is undetectable by id alone (docs/research/bus-unknown-cursor.md).
      await assertReplayWithReset(bus, "cur", foreignId, ids);
    } finally {
      await bus.close();
      await foreign.close();
    }
  });
}
