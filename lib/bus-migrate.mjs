/**
 * `ai-collab bus migrate --to postgres`: copies the SQLite bus store into the Postgres bus schema with
 * the original ids, so stored cursors and history survive the cutover. One transaction, batches of
 * 1000 rows, then the events sequence is set past the copied ids so new publishes continue after them.
 * File bytes stay in the shared filesDir; only the files rows move. The SQLite bus store is retired: this
 * command stays for one release as the upgrade path for an install that still has a bus.db.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stateDir } from "./config.mjs";
import { openPostgresBusStore } from "./bus-postgres.mjs";
import { pgUrl } from "./postgres.mjs";

const BATCH = 1000;

/** The bus data dir, the same resolution scripts/ai-collab-bus.mjs uses. */
export function busDataDir(env = process.env) {
  return env.AI_COLLAB_BUS_DATA || path.join(stateDir(env), "bus");
}

/**
 * Copies dataDir/bus.db into the Postgres `schema` (default "bus") of pgUrl(env).
 * dryRun reads and reports only. resume tolerates a non-empty target and copies only ids past its max.
 * Resolves { events, files, minId, maxId, nextId } — counts of what was copied and the sequence's next value.
 */
export async function migrateBusToPostgres({ env = process.env, dataDir = busDataDir(env), schema = "bus", dryRun = false, resume = false } = {}) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`bus migrate: invalid schema ${schema}`);
  const srcFile = path.join(dataDir, "bus.db");
  if (!fs.existsSync(srcFile)) throw new Error(`bus migrate: no SQLite store at ${srcFile}`);
  const src = new DatabaseSync(srcFile, { readOnly: true });
  const events = src.prepare("SELECT id, topic, time, message, title, attachment FROM events ORDER BY id").all();
  const files = src.prepare("SELECT id, name, type, size, created FROM files ORDER BY id").all();
  src.close();
  const minId = events.length ? Number(events[0].id) : 0;
  const maxId = events.length ? Number(events.at(-1).id) : 0;
  if (dryRun) return { events: events.length, files: files.length, minId, maxId, nextId: maxId + 1, dryRun: true };

  const { default: pg } = await import("pg");
  const url = pgUrl(env);
  // The store's own migrate creates schema, tables and sequence; this command never repeats that DDL.
  const store = await openPostgresBusStore({ url, schema });
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  pool.on("error", () => {}); // an idle client that dies server-side must not crash the command
  try {
    const { rows: [target] } = await pool.query(`SELECT COUNT(*)::int AS n, COALESCE(MAX(id), 0)::bigint AS max_id FROM ${schema}.events`);
    if (Number(target.n) > 0 && !resume) {
      throw new Error(`bus migrate: target ${schema}.events already has ${target.n} rows; pass --resume to copy only ids past its max`);
    }
    const fromId = resume ? Number(target.max_id) : 0;
    const rows = events.filter((e) => Number(e.id) > fromId);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      let copiedEvents = 0;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const values = batch.map((_, j) => `($${j * 6 + 1},$${j * 6 + 2},$${j * 6 + 3},$${j * 6 + 4},$${j * 6 + 5},$${j * 6 + 6})`).join(",");
        const params = batch.flatMap((e) => [String(e.id), e.topic, e.time, e.message, e.title, e.attachment]);
        copiedEvents += (await client.query(`INSERT INTO ${schema}.events(id, topic, time, message, title, attachment) VALUES ${values}`, params)).rowCount;
      }
      let copiedFiles = 0;
      for (let i = 0; i < files.length; i += BATCH) {
        const batch = files.slice(i, i + BATCH);
        const values = batch.map((_, j) => `($${j * 5 + 1},$${j * 5 + 2},$${j * 5 + 3},$${j * 5 + 4},$${j * 5 + 5})`).join(",");
        const params = batch.flatMap((f) => [f.id, f.name, f.type, f.size, f.created]);
        // ON CONFLICT: a resumed copy may re-reach files rows the first pass already wrote.
        copiedFiles += (await client.query(`INSERT INTO ${schema}.files(id, name, type, size, created) VALUES ${values} ON CONFLICT (id) DO NOTHING`, params)).rowCount;
      }
      if (rows.length) {
        await client.query(`SELECT setval(pg_get_serial_sequence('${schema}.events','id'), (SELECT MAX(id) FROM ${schema}.events))`);
      }
      await client.query("COMMIT");
      // Read the sequence on this client: the pool holds one connection and it is still checked out here.
      // An empty copy skips setval, so a never-used sequence (is_called false) already points at its first id.
      const { rows: [seq] } = await client.query(`SELECT pg_get_serial_sequence('${schema}.events','id') AS seq`);
      const { rows: [next] } = await client.query(`SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END AS next FROM ${seq.seq}`);
      return { events: copiedEvents, files: copiedFiles, minId, maxId, nextId: Number(next.next) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
    await store.close();
  }
}

/** `ai-collab bus migrate --to postgres [--dry-run] [--resume]`. Returns an exit code. */
export async function busCommand(argv = [], { env = process.env, out = process.stdout, err = process.stderr } = {}) {
  const usage = "usage: ai-collab bus migrate --to postgres [--dry-run] [--resume]\n";
  const [verb, ...rest] = argv;
  if (verb !== "migrate") {
    err.write(`ai-collab: bus: unknown command "${verb ?? ""}"\n${usage}`);
    return 2;
  }
  let to = "";
  let dryRun = false;
  let resume = false;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--to") to = rest[++i] || "";
    else if (rest[i] === "--dry-run") dryRun = true;
    else if (rest[i] === "--resume") resume = true;
    else {
      err.write(`ai-collab: bus migrate: unknown flag ${rest[i]}\n${usage}`);
      return 2;
    }
  }
  if (to !== "postgres") {
    err.write(`ai-collab: bus migrate: --to ${to || "<target>"} is not supported; only --to postgres\n${usage}`);
    return 2;
  }
  try {
    const r = await migrateBusToPostgres({ env, dryRun, resume });
    if (r.dryRun) out.write(`bus migrate --dry-run: ${r.events} events, ${r.files} files, ids ${r.minId}..${r.maxId}; nothing written\n`);
    else out.write(`bus migrate: copied ${r.events} events, ${r.files} files, ids ${r.minId}..${r.maxId}; next id ${r.nextId}\n`);
    return 0;
  } catch (error) {
    err.write(`ai-collab: bus migrate: ${error.message}\n`);
    return 1;
  }
}
