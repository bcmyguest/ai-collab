// Model-based test of the bus cursor: publish, poll, subscribe, reconnect, restart and prune against lib/bus.ts.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, after } from "node:test";
import diagnostics from "node:diagnostics_channel";
import fc from "fast-check";
import { pollCached, streamEvents } from "../lib/messaging.ts";
import { openPostgresBusStore } from "../lib/bus-postgres.ts";
import { pgUrl } from "../lib/postgres.ts";
import { dbosTestDb } from "./helpers/dbos-env.mjs";
import { tempDir } from "./helpers/tmp.mjs";

// BUS_IMPL points the model at another bus.mjs, e.g. a scratch copy with a planted bug.
const BUS_IMPL = process.env.BUS_IMPL ? path.resolve(process.env.BUS_IMPL) : fileURLToPath(new URL("../lib/bus.ts", import.meta.url));
const { createBusServer, openMemoryStore } = await import(pathToFileURL(BUS_IMPL).href);
const pgUp = await dbosTestDb();

const TOKEN = "tk_bus_cursor_model";
const TOPICS = ["a", "b"];
const SUBSCRIBERS = [0, 1];
const TOPIC_SETS = [["a"], ["b"], ["a", "b"]];
const RETENTION_MS = 3_600_000;
const HOUR_MS = 3_600_000;
const ADVANCES = [0, 2 * HOUR_MS];
const STREAM_SINCES = ["", "all", "1d", "0", "999999"];
const POLL_MODES = ["cursor", "all", "duration", "unknown"];
const POLL_SINCE = { all: "all", duration: "1d", unknown: "999999" };
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const SETTLE_MS = 2000;
const NUM_RUNS = Number(process.env.FC_RUNS ?? 500);
// Client sockets fetch opened; RestartBus waits until the client has seen each one close.
const clientSockets = new Set();
diagnostics.subscribe("undici:client:connected", ({ socket }) => {
  clientSockets.add(socket);
  socket.once("close", () => clientSockets.delete(socket));
});
const SOCKET_CLOSE_MS = 2000;
const SEED = process.env.FC_SEED ? { seed: Number(process.env.FC_SEED) } : {};

/** Abstract state: store kind, virtual clock offset, retained log, attachments, and each subscriber's expected stream. */
function initialModel(kind) {
  return { kind, offsetMs: 0, seq: 0, maxId: 0, log: [], attachments: [], subs: SUBSCRIBERS.map(() => null) };
}

/** Real side: the store, the bus server on a fixed port, and each subscriber's streams and received ids. */
async function openReal(kind, dir) {
  const schema = `bus_m_${Math.random().toString(36).slice(2, 10)}`;
  const real = { kind, dir, schema, store: null, server: null, url: "", subs: SUBSCRIBERS.map(() => null) };
  await startBus(real);
  return real;
}

async function openStore(r) {
  if (r.kind === "postgres") return openPostgresBusStore({ url: pgUrl(process.env), filesDir: path.join(r.dir, "files"), retentionMs: RETENTION_MS, schema: r.schema });
  return openMemoryStore();
}

async function startBus(r, port = 0) {
  r.store = await openStore(r);
  r.server = createBusServer({ store: r.store, token: TOKEN });
  r.url = await r.server.listen(port);
}

function cfgOf(r) {
  return { url: r.url, token: TOKEN, timeoutMs: 2000 };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sameIds(a, b) {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function lastSeenOf(sub) {
  return sub?.expected.at(-1) ?? "";
}

/** Poll rule of lib/bus.ts: an id on this topic reads after it; an unknown id reads the whole topic. */
function expectedPoll(m, topic, since) {
  const events = m.log.filter((e) => e.topic === topic);
  if (isNumeric(since) && events.some((e) => Number(e.id) === Number(since))) return ids(events.filter((e) => Number(e.id) > Number(since)));
  if (isNumeric(since)) return ids(events);
  return ids(sinceFilter(events, since));
}

/** Stream backfill rule of lib/bus.ts: a known numeric since reads every subscribed event with a larger id; an unknown one replays all. */
function expectedBackfill(m, topics, since) {
  const events = m.log.filter((e) => topics.includes(e.topic));
  if (isNumeric(since) && events.some((e) => Number(e.id) === Number(since))) return ids(events.filter((e) => Number(e.id) > Number(since)));
  if (isNumeric(since)) return ids(events);
  return ids(sinceFilter(events, since));
}

/** Reset rule of lib/bus.ts resolve: an event id (up to 8 digits) absent from the topics replays all and flags reset. */
function expectedReset(m, topics, since) {
  return /^\d{1,8}$/.test(since) && !m.log.some((e) => topics.includes(e.topic) && Number(e.id) === Number(since));
}

function isNumeric(since) {
  return /^\d+$/.test(since);
}

function ids(events) {
  return events.map((e) => e.id);
}

function sinceFilter(events, since) {
  if (since === "1d") {
    const cutoff = Math.floor(Date.now() / 1000) - 86400;
    return events.filter((e) => e.time >= cutoff);
  }
  return events;
}

/** Waits until every subscriber has received exactly its expected ids, then checks ids strictly increase. */
async function settle(m, r) {
  const until = Date.now() + SETTLE_MS;
  for (;;) {
    const behind = SUBSCRIBERS.filter((s) => m.subs[s] && (!sameIds(r.subs[s].received, m.subs[s].expected) || r.subs[s].resets !== m.subs[s].resets));
    if (behind.length === 0) break;
    if (Date.now() > until) {
      const s = behind[0];
      assert.deepEqual(r.subs[s].received, m.subs[s].expected, `subscriber ${s} stream differs from the model`);
      assert.equal(r.subs[s].resets, m.subs[s].resets, `subscriber ${s} stream reset flags differ from the model`);
    }
    await sleep(5);
  }
  for (const s of SUBSCRIBERS) {
    const ids = r.subs[s]?.received ?? [];
    ids.slice(1).forEach((id, i) => assert.ok(Number(id) > Number(ids[i]), `subscriber ${s} ids not increasing at ${id}`));
  }
}

/** Checks model against real after every command: poll equals the log, attachments serve or 404, streams settle. */
async function checkInvariants(m, r) {
  await settle(m, r);
  for (const t of TOPICS) {
    const got = (await pollCached(cfgOf(r), t, "all")).map((e) => e.id);
    assert.deepEqual(got, m.log.filter((e) => e.topic === t).map((e) => e.id), `poll all on ${t} differs from the log`);
  }
  for (const a of m.attachments) {
    const res = await fetch(a.url, { headers: { authorization: `Bearer ${TOKEN}` } });
    const retained = m.log.some((e) => e.id === a.id);
    await res.arrayBuffer();
    assert.equal(res.status, retained ? 200 : 404, `attachment of event ${a.id} after prune`);
  }
}

/** Publishes one event over the wire and mirrors it into the model; the id must follow every earlier id. */
async function writeEvent(m, r, topic, attachment) {
  const message = `m${m.seq + 1}`;
  const auth = { authorization: `Bearer ${TOKEN}` };
  const res = attachment
    ? await fetch(`${r.url}/${topic}?${new URLSearchParams({ message, filename: "shot.png" })}`, { method: "PUT", headers: auth, body: PNG })
    : await fetch(`${r.url}/`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ topic, message }) });
  assert.equal(res.status, 200, `publish to ${topic} failed`);
  const ev = await res.json();
  assert.ok(Number(ev.id) > m.maxId, `event id ${ev.id} does not follow ${m.maxId}`);
  m.seq += 1;
  m.maxId = Number(ev.id);
  m.log.push({ id: ev.id, topic, time: ev.time });
  if (attachment) m.attachments.push({ id: ev.id, url: ev.attachment.url });
  for (const sub of m.subs) if (sub?.connected && sub.topics.includes(topic)) sub.expected.push(ev.id);
}

/** Opens a stream for a real subscriber; resolves once the bus has answered and subscribed it. */
function openStream(r, s, topics, since) {
  const rs = r.subs[s];
  const ctrl = new AbortController();
  rs.ctrl = ctrl;
  let markOpen;
  const opened = new Promise((resolve) => { markOpen = resolve; });
  rs.done = (async () => {
    try {
      const onReset = () => { rs.resets += 1; };
      for await (const ev of streamEvents(cfgOf(r), topics, { since, signal: ctrl.signal, onOpen: markOpen, onReset })) rs.received.push(ev.id);
    } catch { /* aborted, or the bus restarted under it */ }
    markOpen();
  })();
  return opened;
}

async function closeReal(r) {
  for (const rs of r.subs) rs?.ctrl?.abort();
  await Promise.all(r.subs.filter(Boolean).map((rs) => rs.done));
  // Each step runs even when an earlier one throws, so a failed run still releases its connections and schema.
  try {
    await r.server.close();
  } finally {
    try {
      await r.store.close();
    } finally {
      if (r.kind === "postgres") await dropSchema(r.schema);
    }
  }
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

class Publish {
  constructor(topic) {
    this.topic = topic;
  }

  check() {
    return true;
  }

  async run(m, r) {
    await writeEvent(m, r, this.topic, false);
    await checkInvariants(m, r);
  }

  toString() {
    return `Publish(${this.topic})`;
  }
}

class PublishAttachment {
  constructor(topic) {
    this.topic = topic;
  }

  check() {
    return true;
  }

  async run(m, r) {
    await writeEvent(m, r, this.topic, true);
    await checkInvariants(m, r);
  }

  toString() {
    return `PublishAttachment(${this.topic})`;
  }
}

class Poll {
  constructor(s, topic, mode) {
    this.s = s;
    this.topic = topic;
    this.mode = mode;
  }

  check() {
    return true;
  }

  async run(m, r) {
    const cursor = lastSeenOf(m.subs[this.s]);
    const since = this.mode === "cursor" ? cursor : POLL_SINCE[this.mode];
    const events = await pollCached(cfgOf(r), this.topic, since);
    assert.deepEqual(events.map((e) => e.id), expectedPoll(m, this.topic, since), `poll ${this.topic} since=${since || '""'} differs from the log slice`);
    // Poll and stream agree: an unknown cursor replays the topic and flags every event reset.
    const reset = expectedReset(m, [this.topic], since);
    for (const e of events) assert.equal(e.reset === true, reset, `poll ${this.topic} since=${since || '""'} reset flag on ${e.id}`);
    await checkInvariants(m, r);
  }

  toString() {
    return `Poll(${this.s}, ${this.topic}, ${this.mode})`;
  }
}

class Subscribe {
  constructor(s, topics, since) {
    this.s = s;
    this.topics = topics;
    this.since = since;
  }

  check(m) {
    return !m.subs[this.s];
  }

  async run(m, r) {
    const expected = expectedBackfill(m, this.topics, this.since);
    const resets = expectedReset(m, this.topics, this.since) ? 1 : 0;
    r.subs[this.s] = { ctrl: null, done: null, received: [], resets: 0 };
    await openStream(r, this.s, this.topics, this.since);
    m.subs[this.s] = { topics: this.topics, connected: true, expected, resets };
    await checkInvariants(m, r);
  }

  toString() {
    return `Subscribe(${this.s}, ${this.topics.join(",")}, ${JSON.stringify(this.since)})`;
  }
}

class Disconnect {
  constructor(s) {
    this.s = s;
  }

  check(m) {
    return Boolean(m.subs[this.s]?.connected);
  }

  async run(m, r) {
    r.subs[this.s].ctrl.abort();
    await r.subs[this.s].done;
    m.subs[this.s].connected = false;
    await checkInvariants(m, r);
  }

  toString() {
    return `Disconnect(${this.s})`;
  }
}

class Reconnect {
  constructor(s) {
    this.s = s;
  }

  check(m) {
    return Boolean(m.subs[this.s]) && !m.subs[this.s].connected;
  }

  async run(m, r) {
    const sub = m.subs[this.s];
    const since = lastSeenOf(sub);
    if (expectedReset(m, sub.topics, since)) sub.resets += 1;
    await openStream(r, this.s, sub.topics, since);
    sub.expected.push(...expectedBackfill(m, sub.topics, since));
    sub.connected = true;
    await checkInvariants(m, r);
  }

  toString() {
    return `Reconnect(${this.s})`;
  }
}

class RestartBus {
  check(m) {
    return m.kind === "postgres";
  }

  async run(m, r) {
    const port = Number(new URL(r.url).port);
    await r.server.close();
    for (const rs of r.subs) if (rs) await rs.done;
    await r.store.close();
    await startBus(r, port);
    // A pooled keep-alive socket to the old server must be gone before the next request reuses it.
    const stale = [...clientSockets].map((socket) => new Promise((resolve) => socket.once("close", resolve)));
    await Promise.race([Promise.all(stale), sleep(SOCKET_CLOSE_MS)]);
    for (const sub of m.subs) if (sub) sub.connected = false;
    await checkInvariants(m, r);
  }

  toString() {
    return "RestartBus";
  }
}

class Prune {
  constructor(advanceMs) {
    this.advanceMs = advanceMs;
  }

  check(m) {
    return m.kind === "postgres";
  }

  async run(m, r) {
    m.offsetMs += this.advanceMs;
    const nowSec = Math.floor(Date.now() / 1000) + Math.floor(m.offsetMs / 1000);
    await r.store.prune(nowSec);
    const cutoff = nowSec - RETENTION_MS / 1000;
    m.log = m.log.filter((e) => e.time >= cutoff);
    await checkInvariants(m, r);
  }

  toString() {
    return `Prune(${this.advanceMs / 1000}s)`;
  }
}

function commandArb(kind) {
  const topic = fc.constantFrom(...TOPICS);
  const sub = fc.constantFrom(...SUBSCRIBERS);
  const arbs = [
    { weight: 4, arbitrary: topic.map((t) => new Publish(t)) },
    { weight: 2, arbitrary: topic.map((t) => new PublishAttachment(t)) },
    { weight: 3, arbitrary: fc.tuple(sub, topic, fc.constantFrom(...POLL_MODES)).map(([s, t, mode]) => new Poll(s, t, mode)) },
    { weight: 3, arbitrary: fc.tuple(sub, fc.constantFrom(...TOPIC_SETS), fc.constantFrom(...STREAM_SINCES)).map(([s, ts, since]) => new Subscribe(s, ts, since)) },
    { weight: 4, arbitrary: sub.map((s) => new Disconnect(s)) },
    { weight: 4, arbitrary: sub.map((s) => new Reconnect(s)) },
  ];
  if (kind === "postgres") {
    arbs.push({ weight: 1, arbitrary: fc.constant(new RestartBus()) });
    arbs.push({ weight: 2, arbitrary: fc.constantFrom(...ADVANCES).map((ms) => new Prune(ms)) });
  }
  return fc.oneof(...arbs);
}

for (const kind of ["memory", "postgres"]) {
  const skip = kind === "postgres" && !pgUp && "Postgres not reachable";
  test(`bus cursor matches the model on the ${kind} store`, { skip }, async () => {
    await fc.assert(fc.asyncProperty(fc.commands([commandArb(kind)], { maxCommands: 14 }), async (cmds) => {
      const dir = tempDir({ after }, "bus-cursor-model-");
      const real = await openReal(kind, dir);
      try {
        await fc.asyncModelRun(() => ({ model: initialModel(kind), real }), cmds);
      } finally {
        await closeReal(real);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }), { numRuns: NUM_RUNS, ...SEED });
  });
}
