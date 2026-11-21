// DBOS-shaped durable execution on node:sqlite: workflows replay checkpointed steps and messages after a restart.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const WORKFLOW_STATUSES = ["PENDING", "SUCCESS", "ERROR", "CANCELLED"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL,
  output TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS steps (workflow_id TEXT NOT NULL, seq INTEGER NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
  output TEXT, error TEXT, started_at INTEGER NOT NULL, finished_at INTEGER, PRIMARY KEY (workflow_id, seq));
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL, topic TEXT NOT NULL,
  value TEXT NOT NULL, dedupe TEXT UNIQUE, consumed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const json = (value) => JSON.stringify(value === undefined ? null : value);
const parse = (text) => (text === null || text === undefined ? undefined : JSON.parse(text));

export class NonDeterminismError extends Error {}

/** Opens (or creates) the log at file; ":memory:" serves tests. */
export function openDurable(file, { now = Date.now } = {}) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  if (file !== ":memory:") chmodSync(file, 0o600);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;");
  db.exec(SCHEMA);
  const q = {
    wfInsert: db.prepare("INSERT INTO workflows (id, name, input, status, created_at, updated_at) VALUES (?, ?, ?, 'PENDING', ?, ?)"),
    wfGet: db.prepare("SELECT * FROM workflows WHERE id = ?"),
    wfPending: db.prepare("SELECT id, name, input FROM workflows WHERE status = 'PENDING' ORDER BY created_at"),
    wfEnd: db.prepare("UPDATE workflows SET status = ?, output = ?, error = ?, updated_at = ? WHERE id = ?"),
    stepGet: db.prepare("SELECT * FROM steps WHERE workflow_id = ? AND seq = ?"),
    stepStart: db.prepare("INSERT INTO steps (workflow_id, seq, name, status, started_at) VALUES (?, ?, ?, 'started', ?)"),
    stepEnd: db.prepare("UPDATE steps SET status = ?, output = ?, error = ?, finished_at = ? WHERE workflow_id = ? AND seq = ?"),
    stepDone: db.prepare("INSERT INTO steps (workflow_id, seq, name, status, output, started_at, finished_at) VALUES (?, ?, ?, 'done', ?, ?, ?)"),
    msgInsert: db.prepare("INSERT OR IGNORE INTO messages (workflow_id, topic, value, dedupe, created_at) VALUES (?, ?, ?, ?, ?)"),
    msgNext: db.prepare("SELECT id, value FROM messages WHERE workflow_id = ? AND topic = ? AND consumed = 0 ORDER BY id"),
    msgConsume: db.prepare("UPDATE messages SET consumed = 1 WHERE id = ?"),
    msgPending: db.prepare("SELECT COUNT(*) AS n FROM messages WHERE workflow_id = ? AND topic = ? AND consumed = 0"),
    kvGet: db.prepare("SELECT value FROM kv WHERE key = ?"),
    kvSet: db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
  };
  const registry = new Map();
  const running = new Map();
  const waiters = new Map();
  const closing = new AbortController();

  function tx(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function wake(id) {
    for (const resolve of waiters.get(id) || []) resolve();
    waiters.delete(id);
  }

  function waitFor(id, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const list = waiters.get(id) || [];
      const onAbort = () => reject(signal.reason);
      list.push(() => { signal.removeEventListener("abort", onAbort); resolve(); });
      waiters.set(id, list);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // The context a workflow function receives; seq numbers its steps and receives in call order.
  function context(id, input, ctrl) {
    let seq = 0;
    const signal = AbortSignal.any([closing.signal, ctrl.signal]);
    const recorded = (n) => q.stepGet.get(id, n);
    return {
      id, input, signal,
      get replaying() { return Boolean(recorded(seq)); },
      async step(name, fn, { onCut } = {}) {
        const n = seq++;
        const row = recorded(n);
        if (row && row.name !== name) throw new NonDeterminismError(`step ${n} of ${id} was ${row.name}, now ${name}`);
        if (row?.status === "done") return parse(row.output);
        if (row?.status === "error") throw new Error(row.error);
        if (row && onCut) {
          const value = await onCut();
          q.stepEnd.run("done", json(value), null, now(), id, n);
          return value;
        }
        if (!row) q.stepStart.run(id, n, name, now());
        try {
          const value = await fn();
          q.stepEnd.run("done", json(value), null, now(), id, n);
          return value;
        } catch (error) {
          if (!signal.aborted) q.stepEnd.run("error", null, String(error?.message || error), now(), id, n);
          throw error;
        }
      },
      async recv(topic, { all = false } = {}) {
        const n = seq++;
        const name = `recv:${topic}`;
        for (;;) {
          const row = recorded(n);
          if (row && row.name !== name) throw new NonDeterminismError(`step ${n} of ${id} was ${row.name}, now ${name}`);
          if (row) return parse(row.output);
          const messages = q.msgNext.all(id, topic);
          if (messages.length) {
            const taken = all ? messages : messages.slice(0, 1);
            const values = taken.map((m) => parse(m.value));
            const value = all ? values : values[0];
            tx(() => {
              for (const m of taken) q.msgConsume.run(m.id);
              q.stepDone.run(id, n, name, json(value), now(), now());
            });
            return value;
          }
          await waitFor(id, signal);
        }
      },
      pending: (topic) => q.msgPending.get(id, topic).n,
    };
  }

  function run(id, name, input) {
    const fn = registry.get(name);
    if (!fn) throw new Error(`no workflow named ${name}`);
    const ctrl = new AbortController();
    const promise = (async () => {
      try {
        const output = await fn(context(id, input, ctrl), input);
        q.wfEnd.run(ctrl.signal.reason === "cancel" ? "CANCELLED" : "SUCCESS", json(output), null, now(), id);
        return output;
      } catch (error) {
        if (closing.signal.aborted) return undefined;
        q.wfEnd.run(ctrl.signal.reason === "cancel" ? "CANCELLED" : "ERROR", null, String(error?.message || error), now(), id);
        throw error;
      } finally {
        running.delete(id);
      }
    })();
    running.set(id, { promise, ctrl });
    promise.catch(() => {});
    return promise;
  }

  return {
    register(name, fn) { registry.set(name, fn); },
    /** Starts a new workflow; the id must be unused. Resolves with its output. */
    startWorkflow(name, id, input) {
      q.wfInsert.run(id, name, json(input), now(), now());
      return run(id, name, input);
    },
    /** Ids of PENDING workflows that recover() would run. */
    pending: () => q.wfPending.all().filter((w) => !running.has(w.id) && registry.has(w.name)).map((w) => w.id),
    /** Re-runs every PENDING workflow from its log; returns their ids. */
    recover() {
      return q.wfPending.all().filter((w) => !running.has(w.id) && registry.has(w.name)).map((w) => {
        run(w.id, w.name, parse(w.input));
        return w.id;
      });
    },
    /** Queues a durable message; dedupe (e.g. an ntfy event id) drops repeats. Returns false for a repeat. */
    send(workflowId, topic, value, { dedupe = null } = {}) {
      const { changes } = q.msgInsert.run(workflowId, topic, json(value), dedupe, now());
      if (changes) wake(workflowId);
      return changes > 0;
    },
    status(id) {
      const row = q.wfGet.get(id);
      return row ? { id, name: row.name, status: row.status, output: parse(row.output), error: row.error } : null;
    },
    result: (id) => running.get(id)?.promise ?? Promise.resolve(parse(q.wfGet.get(id)?.output)),
    cancel(id) { running.get(id)?.ctrl.abort("cancel"); },
    steps: (id) => db.prepare("SELECT seq, name, status, output, error FROM steps WHERE workflow_id = ? ORDER BY seq").all(id),
    getKv: (key) => parse(q.kvGet.get(key)?.value),
    setKv: (key, value) => q.kvSet.run(key, json(value)),
    /** Aborts running workflows where they wait, leaving unfinished steps as started (cut), then closes the file. */
    async close() {
      closing.abort(new Error("durable log closed"));
      await Promise.all([...running.values()].map((r) => r.promise.catch(() => {})));
      db.close();
    },
  };
}
