/**
 * The bus store on Postgres: events and files in the `bus` schema of AI_COLLAB_PG_DATABASE (the DBOS
 * container from lib/postgres.ts), created on first open: the bus's only durable store. Ids, ordering and
 * since-semantics match the memory store in lib/bus.ts.
 *
 * Ids: bigserial. Publishes take a transaction advisory lock, so an id becomes visible only after every
 * lower id has committed; a stream therefore reads "id > cursor" without missing a late commit.
 * NOTIFY on publish wakes every open stream; no store polls.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type pg from "pg";
import { DEFAULT_RETENTION_MS, parseSince, type BusEvent, type PublishInput } from "./bus.ts";
import { THREAD_ID, createThreadStore, migrateThreads } from "./threads.ts";

const PUBLISH_LOCK = 7306457; // pg_advisory_xact_lock key: publishes commit in id order
const SCHEMA_LOCK = 7306458; // serializes CREATE ... IF NOT EXISTS across processes
const FILE_EXT = /\.(png|jpe?g|gif|webp|txt)$/i;
// oxlint-disable-next-line quality/no-known-value-widening -- looked up by a runtime file extension
const FILE_TYPES: Record<string, string | undefined> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".txt": "text/plain; charset=utf-8" };

type EventRow = { id: string; topic: string; time: string; message: string; title: string; attachment: string | null };
type FileRow = { id: string; name: string; type: string; size: string; created: string };
type Stream = { topics: string[]; send: (ev: BusEvent) => void; cursor: string; busy: boolean; dirty: boolean };
export type PostgresBusOptions = { url: string; filesDir?: string; retentionMs?: number; schema?: string; applicationName?: string; log?: (line: string) => void };

function fileType(name: string): string {
  const ext = String(name).slice(String(name).lastIndexOf(".")).toLowerCase();
  return FILE_TYPES[ext] || "application/octet-stream";
}

const rowEvent = (row: EventRow): BusEvent => ({
  id: String(row.id),
  time: Number(row.time),
  event: "message",
  topic: row.topic,
  message: row.message,
  title: row.title,
  ...(row.attachment ? { attachment: JSON.parse(row.attachment) } : {}),
});

/**
 * Opens the Postgres store. `schema` defaults to "bus"; tests pass their own so parallel files never share
 * tables. Resolves once the schema exists and the LISTEN connection is up.
 */
export async function openPostgresBusStore({ url, filesDir, retentionMs = DEFAULT_RETENTION_MS, schema = "bus", applicationName = "ai-collab-bus", log = () => {} }: PostgresBusOptions) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`bus: invalid schema ${schema}`);
  const { default: pg } = await import("pg");
  const channel = `${schema}_events`;
  const pool = new pg.Pool({ connectionString: url, max: 5, application_name: applicationName });
  // An idle client that errors (server restart, terminated backend) is dropped by the pool; without a listener Node would throw.
  pool.on("error", (error) => log(`postgres pool: ${error.message}`));
  const streams = new Set<Stream>();
  let listener: pg.Client | null = null;
  let closing = false;

  if (filesDir) fs.mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  await migrate();

  /** Creates the schema and tables under an advisory lock, so two processes opening at once cannot race. */
  async function migrate(): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.events (
        id BIGSERIAL PRIMARY KEY,
        topic TEXT NOT NULL,
        time BIGINT NOT NULL,
        message TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        attachment TEXT
      )`);
      await client.query(`CREATE INDEX IF NOT EXISTS events_topic_id ON ${schema}.events(topic, id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS events_time ON ${schema}.events(time)`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.files (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        size BIGINT NOT NULL,
        created BIGINT NOT NULL
      )`);
      await migrateThreads(client, schema);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** Each new event wakes every stream: it reads the rows past its cursor, in id order. */
  function drain(s: Stream): Promise<void> {
    if (s.busy) { s.dirty = true; return Promise.resolve(); }
    s.busy = true;
    return (async () => {
      try {
        do {
          s.dirty = false;
          const { rows } = await pool.query<EventRow>(`SELECT * FROM ${schema}.events WHERE topic = ANY($1) AND id > $2 ORDER BY id`, [s.topics, s.cursor]);
          for (const row of rows) {
            s.cursor = String(row.id);
            s.send(rowEvent(row));
          }
        } while (s.dirty);
      } finally {
        s.busy = false;
      }
    })();
  }

  /** Keeps one LISTEN connection; after a drop it reopens and catches every stream up, so no wake is lost. */
  async function listen(): Promise<void> {
    const client = new pg.Client({ connectionString: url, application_name: applicationName });
    listener = client;
    client.on("notification", () => { for (const s of streams) drain(s).catch(() => {}); });
    // error and end can both fire for one drop: the first one clears listener, so only one reconnect is scheduled.
    const lost = () => {
      if (closing || listener !== client) return;
      listener = null;
      setTimeout(() => listen().catch(lost), 1000).unref();
    };
    client.on("error", (error) => { log(`postgres listener: ${error.message}`); lost(); });
    client.on("end", lost);
    await client.connect();
    await client.query(`LISTEN ${channel}`);
    for (const s of streams) drain(s).catch(() => {});
  }
  await listen();

  const backlog = (topics: string[], since: string, high: string): Promise<{ rows: EventRow[] }> => {
    const s = parseSince(since);
    if (s.kind === "all") return pool.query<EventRow>(`SELECT * FROM ${schema}.events WHERE topic = ANY($1) AND id <= $2 ORDER BY id`, [topics, high]);
    if (s.kind === "time") return pool.query<EventRow>(`SELECT * FROM ${schema}.events WHERE topic = ANY($1) AND id <= $2 AND time >= $3 ORDER BY id`, [topics, high, s.value]);
    if (s.kind === "id") return pool.query<EventRow>(`SELECT * FROM ${schema}.events WHERE topic = ANY($1) AND id <= $2 AND id > $3 ORDER BY id`, [topics, high, s.value]);
    return Promise.resolve({ rows: [] });
  };

  const store = {
    kind: "postgres",
    threads: createThreadStore({ pool, schema }),
    async publish({ topic, message, title = "", attachment = null, threadId = null }: Omit<PublishInput, "threadId"> & { threadId?: string | null }): Promise<BusEvent> {
      const time = Math.floor(Date.now() / 1000);
      const client = await pool.connect();
      let id: string;
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1)", [PUBLISH_LOCK]);
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO ${schema}.events(topic, time, message, title, attachment, thread_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [topic, time, message, title, attachment ? JSON.stringify(attachment) : null, THREAD_ID.test(threadId ?? "") ? threadId : null],
        );
        id = String(rows[0].id);
        await client.query("SELECT pg_notify($1, $2)", [channel, id]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      return { id, time, event: "message", topic, message, title, ...(attachment ? { attachment } : {}) };
    },
    async resolve(topics: string[], since: string) {
      const s = parseSince(since);
      if (s.kind === "all" || s.kind === "time") return { since, reset: false };
      // Ids past 2^53 would overflow the bigint comparison; no retained event has one.
      if (s.kind === "id" && s.value <= Number.MAX_SAFE_INTEGER) {
        const { rows } = await pool.query(`SELECT 1 FROM ${schema}.events WHERE topic = ANY($1) AND id = $2 LIMIT 1`, [topics, s.value]);
        if (rows.length) return { since, reset: false };
      }
      return { since: "all", reset: true };
    },
    async poll(topic: string, since: string): Promise<BusEvent[]> {
      const s = parseSince(since || "all");
      if (s.kind === "time") return (await pool.query<EventRow>(`SELECT * FROM ${schema}.events WHERE topic = $1 AND time >= $2 ORDER BY id`, [topic, s.value])).rows.map(rowEvent);
      if (s.kind === "id") {
        const { rows: known } = await pool.query(`SELECT id FROM ${schema}.events WHERE topic = $1 AND id = $2`, [topic, s.value]);
        if (known.length) return (await pool.query<EventRow>(`SELECT * FROM ${schema}.events WHERE topic = $1 AND id > $2 ORDER BY id`, [topic, s.value])).rows.map(rowEvent);
      }
      return (await pool.query<EventRow>(`SELECT * FROM ${schema}.events WHERE topic = $1 ORDER BY id`, [topic])).rows.map(rowEvent);
    },
    async stream(topics: string[], since: string, send: (ev: BusEvent) => void) {
      // high is read first: the backlog stops at high, and the cursor starts there, so nothing falls between.
      const { rows: [top] } = await pool.query<{ high: string }>(`SELECT COALESCE(MAX(id), 0) AS high FROM ${schema}.events`);
      const high = String(top.high);
      for (const row of (await backlog(topics, since, high)).rows) send(rowEvent(row));
      const s: Stream = { topics, send, cursor: high, busy: false, dirty: false };
      streams.add(s);
      try {
        await drain(s);
      } catch (error) {
        streams.delete(s);
        throw error;
      }
      return () => { streams.delete(s); };
    },
    async putFile({ name, data }: { name: string; data: Buffer }) {
      const ext = (FILE_EXT.exec(name)?.[0] || ".bin").toLowerCase();
      const id = `${randomBytes(8).toString("hex")}${ext}`;
      const type = fileType(name);
      if (filesDir) {
        const dest = path.join(filesDir, id);
        const tmp = `${dest}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, data, { mode: 0o600 });
        fs.renameSync(tmp, dest);
      }
      await pool.query(`INSERT INTO ${schema}.files(id, name, type, size, created) VALUES ($1,$2,$3,$4,$5)`,
        [id, String(name).slice(0, 200), type, data.length, Math.floor(Date.now() / 1000)]);
      return { file: id, type, size: data.length };
    },
    async getFile(id: string) {
      const { rows: [row] } = await pool.query<FileRow>(`SELECT * FROM ${schema}.files WHERE id = $1`, [String(id)]);
      if (!row || !filesDir) return null;
      try {
        return { data: fs.readFileSync(path.join(filesDir, String(id))), type: row.type, name: row.name, size: Number(row.size) };
      } catch {
        return null;
      }
    },
    async prune(now = Math.floor(Date.now() / 1000)) {
      const cutoff = now - Math.floor(retentionMs / 1000);
      const gone = (await pool.query(`DELETE FROM ${schema}.events WHERE time < $1`, [cutoff])).rowCount;
      const { rows: stale } = await pool.query<{ id: string }>(`SELECT id FROM ${schema}.files WHERE created < $1`, [cutoff]);
      for (const row of stale) {
        if (filesDir) fs.rmSync(path.join(filesDir, row.id), { force: true });
        await pool.query(`DELETE FROM ${schema}.files WHERE id = $1`, [row.id]);
      }
      return { events: gone, files: stale.length };
    },
    /** True when the events table holds no row; the bus start refuses an empty store beside a leftover bus.db. */
    async isEmpty(): Promise<boolean> {
      return (await pool.query<{ empty: boolean }>(`SELECT NOT EXISTS (SELECT 1 FROM ${schema}.events) AS empty`)).rows[0].empty;
    },
    async close() {
      closing = true;
      streams.clear();
      const client = listener;
      listener = null;
      if (client) await client.end().catch(() => {});
      await pool.end();
    },
  };
  return store;
}
