// DBOS-shaped durable execution on node:sqlite: workflows replay checkpointed steps and messages after a restart.
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const WORKFLOW_STATUSES = ["PENDING", "SUCCESS", "ERROR", "CANCELLED", "SKIPPED"];
const MAX_TIMER_MS = 2 ** 31 - 1;
// A missed tick this close to the next boundary waits for that boundary.
const GRACE_MS = 60_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL,
  output TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS workflows_name ON workflows (name, created_at);
CREATE TABLE IF NOT EXISTS steps (workflow_id TEXT NOT NULL, seq INTEGER NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
  output TEXT, error TEXT, started_at INTEGER NOT NULL, finished_at INTEGER, PRIMARY KEY (workflow_id, seq));
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL, topic TEXT NOT NULL,
  value TEXT NOT NULL, dedupe TEXT UNIQUE, consumed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const json = (value) => JSON.stringify(value === undefined ? null : value);
const parse = (text) => (text === null || text === undefined ? undefined : JSON.parse(text));

// Resolves after ms, or rejects with the signal's reason when it aborts first. Not checkpointed.
function pauseFor(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, Math.max(0, ms));
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

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
    wfInsertIgnore: db.prepare("INSERT OR IGNORE INTO workflows (id, name, input, status, created_at, updated_at) VALUES (?, ?, ?, 'PENDING', ?, ?)"),
    wfRecord: db.prepare("INSERT OR IGNORE INTO workflows (id, name, input, status, output, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    wfGet: db.prepare("SELECT * FROM workflows WHERE id = ?"),
    wfLatestNamed: db.prepare("SELECT * FROM workflows WHERE name = ? ORDER BY created_at DESC, id DESC LIMIT 1"),
    wfListNamed: db.prepare("SELECT * FROM workflows WHERE name = ? ORDER BY created_at DESC, id DESC LIMIT ?"),
    wfLastActual: db.prepare("SELECT input FROM workflows WHERE name = ? AND status != 'SKIPPED' AND id NOT LIKE '%@manual@%' ORDER BY created_at DESC LIMIT 1"),
    wfPending: db.prepare("SELECT id, name, input FROM workflows WHERE status = 'PENDING' ORDER BY created_at"),
    wfEnd: db.prepare("UPDATE workflows SET status = ?, output = ?, error = ?, updated_at = ? WHERE id = ?"),
    stepGet: db.prepare("SELECT * FROM steps WHERE workflow_id = ? AND seq = ?"),
    stepStart: db.prepare("INSERT INTO steps (workflow_id, seq, name, status, started_at) VALUES (?, ?, ?, 'started', ?)"),
    stepStartIgnore: db.prepare("INSERT OR IGNORE INTO steps (workflow_id, seq, name, status, started_at) VALUES (?, ?, ?, 'started', ?)"),
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
  const schedules = new Map();
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
  // ownStep: the first step's row was written with this run, so it is not a cut.
  function context(id, input, ctrl, ownStep = false) {
    let seq = 0;
    let own = ownStep;
    const signal = AbortSignal.any([closing.signal, ctrl.signal]);
    const recorded = (n) => q.stepGet.get(id, n);
    const ctx = {
      id, input, signal,
      get replaying() { return Boolean(recorded(seq)); },
      async step(name, fn, { onCut } = {}) {
        const n = seq++;
        const row = recorded(n);
        const adopted = own && row?.status === "started";
        own = false;
        if (row && row.name !== name) throw new NonDeterminismError(`step ${n} of ${id} was ${row.name}, now ${name}`);
        if (row?.status === "done") return parse(row.output);
        if (row?.status === "error") throw new Error(row.error);
        if (row && onCut && !adopted) {
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
    // Waits ms without a checkpoint: a restart waits again. Use it for polling, never for a deadline.
    ctx.pause = (ms) => pauseFor(ms, signal);
    // Waits ms from the first execution: the deadline is checkpointed, so a restart waits only the rest.
    ctx.sleep = async (ms) => {
      const until = await ctx.step("sleep", () => now() + ms);
      await ctx.step("sleep.wait", () => pauseFor(until - now(), signal));
    };
    return ctx;
  }

  function run(id, name, input, { ownStep = false } = {}) {
    const fn = registry.get(name);
    if (!fn) throw new Error(`no workflow named ${name}`);
    const ctrl = new AbortController();
    const promise = (async () => {
      try {
        const output = await fn(context(id, input, ctrl, ownStep), input);
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
    running.set(id, { promise, ctrl, name });
    promise.catch(() => {});
    return promise;
  }

  const tickName = (name) => `scheduled:${name}`;
  const tickId = (name, at) => `${name}@${new Date(at).toISOString()}`;
  // Interval ticks align to the epoch, so a tick's id is the same on every boot.
  const dueAt = (everyMs, at) => Math.floor(at / everyMs) * everyMs;
  const overlapping = (name) => [...running.values()].some((r) => r.name === tickName(name));

  // Why a scheduled tick at scheduledTime is skipped for an edited interval, or null.
  function intervalReason(s, scheduledTime) {
    const last = q.wfLastActual.get(tickName(s.name));
    if (!last) return null;
    const previous = parse(last.input).scheduledTime;
    if (scheduledTime - previous >= s.everyMs) return null;
    return `interval changed: previous tick ${new Date(previous).toISOString()} is under ${s.everyMs} ms earlier`;
  }

  // Starts a tick once and returns {id, status}; a tick that cannot start is recorded SKIPPED with its reason.
  function fire(s, scheduledTime, actualTime, { manual = false } = {}) {
    if (closing.signal.aborted) return { id: null, status: "closed" };
    const name = tickName(s.name);
    const id = manual ? `${s.name}@manual@${randomUUID()}` : tickId(s.name, scheduledTime);
    if (!manual && q.wfGet.get(id)) return { id, status: "recorded" };
    const input = { scheduledTime, actualTime, ...(manual ? { manual: true } : {}) };
    const reason = (!manual && intervalReason(s, scheduledTime)) || (overlapping(s.name) && "previous run still going");
    if (reason) {
      q.wfRecord.run(id, name, json(input), "SKIPPED", json({ skipped: reason }), now(), now());
      return { id, status: "skipped" };
    }
    // The workflow row and its first step commit together, so a crash leaves either nothing or a started step.
    const inserted = tx(() => {
      if (!q.wfInsertIgnore.run(id, name, json(input), now(), now()).changes) return false;
      if (s.firstStep) q.stepStartIgnore.run(id, 0, s.firstStep, now());
      return true;
    });
    if (!inserted) return { id, status: "recorded" };
    run(id, name, input, { ownStep: Boolean(s.firstStep) }).catch(() => {});
    return { id, status: "started" };
  }

  // Sleeps until the next tick boundary, then fires the latest due tick and re-arms.
  function arm(s) {
    if (closing.signal.aborted) return;
    clearTimeout(s.timer);
    const at = now();
    const wait = dueAt(s.everyMs, at) + s.everyMs - at;
    s.timer = setTimeout(() => {
      s.timer = null;
      fire(s, dueAt(s.everyMs, now()), now());
      arm(s);
    }, Math.min(wait, MAX_TIMER_MS));
    s.timer.unref();
  }

  return {
    register(name, fn) { registry.set(name, fn); },
    /**
     * DBOS-style scheduled workflow: fn(scheduledTime, actualTime, wf) runs once per everyMs tick as workflow
     * `<name>@<scheduledTime ISO>`. firstStep names a step the tick records with its row, before fn runs.
     */
    scheduled(name, { everyMs, firstStep = null } = {}, fn) {
      if (!Number.isSafeInteger(everyMs) || everyMs < 1) throw new Error(`schedule ${name}: everyMs must be a positive integer`);
      if (typeof fn !== "function") throw new Error(`schedule ${name}: fn must be a function`);
      if (schedules.has(name)) throw new Error(`schedule ${name} is already registered`);
      registry.set(tickName(name), (wf, input) => fn(new Date(input.scheduledTime), new Date(input.actualTime), wf));
      schedules.set(name, { name, everyMs, firstStep, timer: null });
    },
    /** Fires each schedule's latest due tick unless it is within grace of the next boundary, then arms its timer. */
    startSchedules() {
      for (const s of schedules.values()) {
        const at = now();
        const due = dueAt(s.everyMs, at);
        if (due + s.everyMs - at >= Math.min(GRACE_MS, Math.floor(s.everyMs / 2))) fire(s, due, at);
        arm(s);
      }
    },
    hasSchedule: (name) => schedules.has(name),
    /** Starts a manual tick now under <name>@manual@<uuid>; resolves {id, status: "started" | "skipped"}. */
    runScheduled(name) {
      const s = schedules.get(name);
      if (!s) throw new Error(`no schedule named ${name}`);
      const at = now();
      return fire(s, at, at, { manual: true });
    },
    /** Each schedule with its next tick (ISO) and its latest tick row. */
    schedules() {
      const at = now();
      return [...schedules.values()].map((s) => {
        const last = q.wfLatestNamed.get(tickName(s.name));
        return {
          name: s.name, everyMs: s.everyMs, nextRun: new Date(dueAt(s.everyMs, at) + s.everyMs).toISOString(),
          last: last ? { id: last.id, status: last.status, scheduledTime: new Date(parse(last.input).scheduledTime).toISOString(), output: parse(last.output), error: last.error } : null,
        };
      });
    },
    /** The latest tick rows of one schedule, newest first: status, scheduled time, output and error. */
    scheduleRuns(name, limit = 20) {
      if (!schedules.has(name)) throw Object.assign(new Error(`no schedule named ${name}`), { status: 404 });
      return q.wfListNamed.all(tickName(name), limit).map((row) => ({
        id: row.id, status: row.status, scheduledTime: new Date(parse(row.input).scheduledTime).toISOString(), updatedAt: row.updated_at, output: parse(row.output), error: row.error,
      }));
    },
    /** Starts a new workflow; the id must be unused. Resolves with its output. */
    startWorkflow(name, id, input) {
      q.wfInsert.run(id, name, json(input), now(), now());
      return run(id, name, input);
    },
    /** Starts a workflow once per id: null when the id already has a row, so a repeated start does nothing. */
    startWorkflowOnce(name, id, input) {
      if (!q.wfInsertIgnore.run(id, name, json(input), now(), now()).changes) return null;
      return run(id, name, input);
    },
    /** The latest workflows of one name, newest first, with parsed input and output. */
    listNamed: (name, limit = 100) => q.wfListNamed.all(name, limit).map((row) => ({
      id: row.id, name: row.name, status: row.status, input: parse(row.input), output: parse(row.output), error: row.error,
      createdAt: row.created_at, updatedAt: row.updated_at,
    })),
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
    /**
     * Deletes the steps and messages of finished workflows of the given names last updated before `before` (ms). The
     * workflow row stays as a tombstone, so a message the log knows is never started again. Resolves the count pruned.
     */
    prune(names, before) {
      let count = 0;
      for (const name of names) {
        const ids = db.prepare("SELECT id FROM workflows WHERE name = ? AND status != 'PENDING' AND updated_at < ? AND id IN (SELECT workflow_id FROM steps UNION SELECT workflow_id FROM messages)").all(name, before).map((r) => r.id);
        tx(() => {
          for (const id of ids) {
            db.prepare("DELETE FROM steps WHERE workflow_id = ?").run(id);
            db.prepare("DELETE FROM messages WHERE workflow_id = ?").run(id);
          }
        });
        count += ids.length;
      }
      return count;
    },
    /** Unconsumed messages on a topic of a workflow, consumed in one transaction: a message is handed over once. */
    drain(workflowId, topic) {
      const rows = db.prepare("SELECT id, value FROM messages WHERE workflow_id = ? AND topic = ? AND consumed = 0 ORDER BY id").all(workflowId, topic);
      tx(() => { for (const r of rows) q.msgConsume.run(r.id); });
      return rows.map((r) => parse(r.value));
    },
    /** Unconsumed messages on a topic of a workflow. */
    pendingCount: (workflowId, topic) => q.msgPending.get(workflowId, topic).n,
    /** Aborts running workflows where they wait, leaving unfinished steps as started (cut), then closes the file. */
    async close() {
      for (const s of schedules.values()) clearTimeout(s.timer);
      closing.abort(new Error("durable log closed"));
      await Promise.all([...running.values()].map((r) => r.promise.catch(() => {})));
      db.close();
    },
  };
}
