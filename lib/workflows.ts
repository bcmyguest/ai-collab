/**
 * Workflow engine switch: `workflowEngine: "sqlite"` (default) keeps the hand-rolled durable log;
 * `"dbos"` runs the same interface on DBOS Transact TS over Postgres. Callers (runner, schedules,
 * delivery, pattern runs) use one interface; methods that were sync become async, which the
 * call sites await. DBOS equivalents verified against the 5.7.0 d.ts and docs.dbos.dev:
 * startWorkflow→startWorkflow(workflowID), step→runStep, send/recv→send(idempotencyKey)/recv,
 * status/result→listWorkflows/retrieveWorkflow, cancel→cancelWorkflow, recovery→launch().
 */
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { WorkflowStatus } from "@dbos-inc/dbos-sdk";
import pg from "pg";
import { openDurable } from "./durable.mjs";

type Json = Record<string, unknown>;
/** A workflow's result, kv value, or message: the JSON the engines checkpoint verbatim. */
type WfValue = Json | string | number | boolean | null | undefined | WfValue[];
type NowFn = () => number;
type WfFn = (wf: Json, input: Json) => Promise<WfValue>;
type Schedule = { name: string; everyMs: number; firstStep: string | null; timer: ReturnType<typeof setTimeout> | null };
type StepRow = { functionID: number; name: string; output: unknown; error: Error | null };

export interface Workflows {
  register(name: string, fn: WfFn): void;
  scheduled(name: string, opts: { everyMs: number; firstStep?: string | null }, fn: (scheduled: Date, actual: Date, wf: Json) => Promise<WfValue>): void;
  startSchedules(): Promise<void>;
  hasSchedule(name: string): boolean;
  runScheduled(name: string): Promise<{ id: string | null; status: string } | null>;
  schedules(): Promise<Json[]>;
  scheduleRuns(name: string, limit?: number): Promise<Json[]>;
  startWorkflow(name: string, id: string, input: Json): Promise<WfValue>;
  /** True when this call started the workflow; false when the id already had a run. */
  startWorkflowOnce(name: string, id: string, input: Json): Promise<boolean>;
  /** Set on engines returned by openWorkflows; createRunner uses it to skip re-adapting a raw sqlite log. */
  readonly isAsync?: boolean;
  listNamed(name: string, limit?: number): Promise<Json[]>;
  pending(): Promise<string[]>;
  recover(): Promise<string[]>;
  send(workflowId: string, topic: string, value: unknown, opts?: { dedupe?: string | null }): Promise<boolean>;
  status(id: string): Promise<Json | null>;
  result(id: string): Promise<WfValue>;
  cancel(id: string): Promise<void>;
  steps(id: string): Promise<Json[]>;
  getKv(key: string): Promise<WfValue>;
  setKv(key: string, value: unknown): Promise<void>;
  prune(names: string[], before: number): Promise<number>;
  drain(workflowId: string, topic: string): Promise<unknown[]>;
  pendingCount(workflowId: string, topic: string): Promise<number>;
  close(): Promise<void>;
}

/** Opens the engine named by `engine`: "sqlite" (default) or "dbos". */
export async function openWorkflows(opts: { engine?: string; file?: string; pgUrl?: string; now?: NowFn; log?: (m: string) => void }): Promise<Workflows> {
  if ((opts.engine || "sqlite") === "sqlite") {
    if (!opts.file) throw new Error("openWorkflows: the sqlite engine needs a file");
    return adaptSqlite(openDurable(opts.file, { now: opts.now }));
  }
  return await openDbosEngine(opts);
}

// The sync surface of lib/durable.mjs as the adapter needs it; tsc infers the .mjs exports too loosely to use directly.
type SqliteDurable = {
  register(name: string, fn: WfFn): void;
  scheduled(name: string, opts: { everyMs: number; firstStep?: string | null }, fn: (scheduled: Date, actual: Date, wf: Json) => Promise<WfValue>): void;
  hasSchedule(name: string): boolean;
  startSchedules(): void;
  runScheduled(name: string): { id: string | null; status: string } | null;
  schedules(): Json[];
  scheduleRuns(name: string, limit?: number): Json[];
  startWorkflow(name: string, id: string, input: Json): WfValue;
  startWorkflowOnce(name: string, id: string, input: Json): Promise<WfValue> | null;
  listNamed(name: string, limit?: number): Json[];
  pending(): string[];
  recover(): string[];
  send(workflowId: string, topic: string, value: unknown, opts?: { dedupe?: string | null }): boolean;
  status(id: string): Json | null;
  result(id: string): WfValue;
  cancel(id: string): void;
  steps(id: string): Json[];
  getKv(key: string): WfValue;
  setKv(key: string, value: unknown): void;
  prune(names: string[], before: number): number;
  drain(workflowId: string, topic: string): unknown[];
  pendingCount(workflowId: string, topic: string): number;
  close(): void;
};

/** Wraps the sync sqlite durable log so both engines expose one async interface; awaiting a sync value is a no-op. */
export function adaptSqlite(raw: unknown): Workflows {
  const d = raw as SqliteDurable;
  return {
    isAsync: true,
    register: (name, fn) => d.register(name, fn),
    scheduled: (name, opts, fn) => d.scheduled(name, opts, fn),
    hasSchedule: (name) => d.hasSchedule(name),
    async startSchedules() { d.startSchedules(); },
    async runScheduled(name) { return d.runScheduled(name); },
    async schedules() { return d.schedules(); },
    async scheduleRuns(name, limit) { return d.scheduleRuns(name, limit); },
    async startWorkflow(name, id, input) { return d.startWorkflow(name, id, input); },
    async startWorkflowOnce(name, id, input) {
      const run = d.startWorkflowOnce(name, id, input);
      if (run === null) return false;
      run.catch(() => {}); // the caller learns "started" from the boolean; the result promise is the runner's business
      return true;
    },
    async listNamed(name, limit) { return d.listNamed(name, limit); },
    async pending() { return d.pending(); },
    async recover() { return d.recover(); },
    async send(workflowId, topic, value, o) { return d.send(workflowId, topic, value, o); },
    async status(id) { return d.status(id); },
    async result(id) { return d.result(id); },
    async cancel(id) { d.cancel(id); },
    async steps(id) { return d.steps(id); },
    async getKv(key) { return d.getKv(key); },
    async setKv(key, value) { d.setKv(key, value); },
    async prune(names, before) { return d.prune(names, before); },
    async drain(workflowId, topic) { return d.drain(workflowId, topic); },
    async pendingCount(workflowId, topic) { return d.pendingCount(workflowId, topic); },
    async close() { await d.close(); },
  };
}

const MAX_TIMER_MS = 2 ** 31 - 1;
const GRACE_MS = 60_000;
const tickName = (name: string) => `scheduled:${name}`;
const tickId = (name: string, at: number) => `${name}@${new Date(at).toISOString()}`;
const dueAt = (everyMs: number, at: number) => Math.floor(at / everyMs) * everyMs;
const asJson = (value: unknown): Json => (value && typeof value === "object" ? value as Json : {});
/** DBOS stores workflow arguments as an array; the engine passes one object argument. */
const wfInput = (r: WorkflowStatus): Json => (Array.isArray(r.input) ? asJson(r.input[0]) : asJson(r.input));

/** The DBOS-backed engine. Same surface as openDurable; every query is async (Postgres). */
async function openDbosEngine({ pgUrl = "", now = Date.now, log = () => {} }: { pgUrl?: string; now?: NowFn; log?: (m: string) => void }): Promise<Workflows> {
  const pool = new pg.Pool({ connectionString: pgUrl, max: 5 });
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ai_collab;
    CREATE TABLE IF NOT EXISTS ai_collab.kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_collab.started (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS ai_collab.dedupe (key TEXT PRIMARY KEY, created_at BIGINT NOT NULL);`);

  const registry = new Map<string, WfFn>();
  const dbosFns = new Map<string, (input: Json) => Promise<WfValue>>();
  const schedules = new Map<string, Schedule>();
  const closing = new AbortController();
  let launched: Promise<void> | null = null;

  // Registration must finish before launch; the runner registers at boot, so launch on first async use.
  function ready(): Promise<void> {
    if (!launched) {
      launched = (async () => {
        for (const name of registry.keys()) if (!dbosFns.has(name)) registerDbos(name);
        DBOS.setConfig({ name: "ai-collab", systemDatabaseUrl: pgUrl });
        await DBOS.launch();
      })();
    }
    return launched;
  }

  function registerDbos(name: string): (input: Json) => Promise<WfValue> {
    const wf = registry.get(name);
    if (!wf) throw new Error(`no workflow named ${name}`);
    const fn = DBOS.registerWorkflow(async (input: Json) => await wf(makeContext(String(asJson(input).__id ?? ""), input), input), { name });
    dbosFns.set(name, fn);
    return fn;
  }

  function makeContext(id: string, input: Json) {
    return {
      id, input, signal: closing.signal,
      get replaying() { return false; },
      step: async (name: string, fn: () => Promise<WfValue>) => await DBOS.runStep(fn, { name }),
      recv: async (topic: string, { all = false } = {}) => {
        if (!all) {
          const first = await DBOS.recv(topic, { timeoutSeconds: 0 });
          if (first !== null) return first;
          for (;;) {
            const next = await DBOS.recv(topic, { timeoutSeconds: 60 });
            if (next !== null) return next;
          }
        }
        const values: unknown[] = [];
        for (;;) {
          const next = await DBOS.recv(topic, { timeoutSeconds: 0 });
          if (next === null) break;
          values.push(next);
        }
        return values;
      },
      pending: async (topic: string) => await pendingCount(id, topic),
      pause: (ms: number) => new Promise<void>((resolve, reject) => {
        if (closing.signal.aborted) return reject(closing.signal.reason);
        const t = setTimeout(() => { closing.signal.removeEventListener("abort", onAbort); resolve(); }, Math.max(0, ms));
        function onAbort() { clearTimeout(t); reject(closing.signal.reason); }
        closing.signal.addEventListener("abort", onAbort, { once: true });
      }),
      sleep: async (ms: number) => { await DBOS.sleep(ms); },
    };
  }

  function dbosFn(name: string): (input: Json) => Promise<WfValue> {
    const fn = dbosFns.get(name);
    if (fn) return fn;
    if (launched) throw new Error(`workflow ${name} registered after launch; register before the first async call`);
    return registerDbos(name);
  }

  async function pendingCount(workflowId: string, topic: string): Promise<number> {
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM dbos.notifications WHERE destination_uuid = $1 AND topic = $2 AND consumed = false", [workflowId, topic]);
    return rows[0].n as number;
  }

  function mapStatus(r: WorkflowStatus) {
    return {
      id: r.workflowID, name: r.workflowName, status: r.status,
      output: r.output,
      error: r.error instanceof Error ? r.error.message : (typeof r.error === "string" ? r.error : null),
      input: Array.isArray(r.input) ? r.input[0] : undefined,
      createdAt: r.createdAt, updatedAt: r.updatedAt ?? r.createdAt,
    };
  }

  async function statusRow(id: string): Promise<Json | null> {
    await ready();
    const rows = await DBOS.listWorkflows({ workflowIDs: [id], loadOutput: true });
    return rows[0] ? mapStatus(rows[0]) : null;
  }

  async function startOnce(name: string, id: string, input: Json): Promise<boolean> {
    await ready();
    const { rowCount } = await pool.query("INSERT INTO ai_collab.started(id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
    if (!rowCount) return false;
    const h = await DBOS.startWorkflow(dbosFn(name), { workflowID: id })({ ...input, __id: id });
    h.getResult().catch(() => {});
    return true;
  }

  async function pendingIds(): Promise<string[]> {
    await ready();
    const rows = await DBOS.listWorkflows({ status: "PENDING" });
    return rows.filter((r) => registry.has(r.workflowName)).map((r) => r.workflowID);
  }

  // Why a scheduled tick at scheduledTime is skipped for an edited interval, or null.
  async function intervalReason(s: Schedule, scheduledTime: number): Promise<string | null> {
    const rows = await DBOS.listWorkflows({ workflowName: tickName(s.name), limit: 1, sortDesc: true, loadInput: true });
    const last = rows.find((r) => r.status !== "SKIPPED" && !r.workflowID.includes("@manual@"));
    if (!last) return null;
    const previous = Number(wfInput(last).scheduledTime);
    if (scheduledTime - previous >= s.everyMs) return null;
    return `interval changed: previous tick ${new Date(previous).toISOString()} is under ${s.everyMs} ms earlier`;
  }

  async function fire(s: Schedule, scheduledTime: number, actualTime: number, { manual = false }: { manual?: boolean } = {}): Promise<{ id: string | null; status: string }> {
    if (closing.signal.aborted) return { id: null, status: "closed" };
    const name = tickName(s.name);
    const id = manual ? `${s.name}@manual@${crypto.randomUUID()}` : tickId(s.name, scheduledTime);
    if (!manual) {
      const reason = await intervalReason(s, scheduledTime);
      if (reason) {
        await pool.query("INSERT INTO ai_collab.started(id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
        return { id, status: "skipped" };
      }
    }
    const input = { scheduledTime, actualTime, __id: id, ...(manual ? { manual: true } : {}) };
    const started = await startOnce(name, id, input);
    return { id, status: started ? "started" : "recorded" };
  }

  function arm(s: Schedule): void {
    if (closing.signal.aborted) return;
    if (s.timer) clearTimeout(s.timer);
    const at = now();
    const wait = dueAt(s.everyMs, at) + s.everyMs - at;
    s.timer = setTimeout(() => {
      s.timer = null;
      void fire(s, dueAt(s.everyMs, now()), now()).catch(() => {});
      arm(s);
    }, Math.min(wait, MAX_TIMER_MS));
    s.timer.unref();
  }

  return {
    isAsync: true,
    register(name, fn) { registry.set(name, fn); },
    scheduled(name, { everyMs, firstStep = null }, fn) {
      if (!Number.isSafeInteger(everyMs) || everyMs < 1) throw new Error(`schedule ${name}: everyMs must be a positive integer`);
      if (typeof fn !== "function") throw new Error(`schedule ${name}: fn must be a function`);
      if (schedules.has(name)) throw new Error(`schedule ${name} is already registered`);
      registry.set(tickName(name), (wf, input) => fn(new Date(Number(input.scheduledTime)), new Date(Number(input.actualTime)), wf));
      schedules.set(name, { name, everyMs, firstStep, timer: null });
    },
    async startSchedules() {
      for (const s of schedules.values()) {
        const at = now();
        const due = dueAt(s.everyMs, at);
        if (due + s.everyMs - at >= Math.min(GRACE_MS, Math.floor(s.everyMs / 2))) await fire(s, due, at);
        arm(s);
      }
    },
    hasSchedule: (name) => schedules.has(name),
    async runScheduled(name) {
      const s = schedules.get(name);
      if (!s) throw new Error(`no schedule named ${name}`);
      const at = now();
      return await fire(s, at, at, { manual: true });
    },
    async schedules() {
      const at = now();
      const out: Json[] = [];
      for (const s of schedules.values()) {
        const rows = await DBOS.listWorkflows({ workflowName: tickName(s.name), limit: 50, sortDesc: true, loadInput: true, loadOutput: true });
        const last = rows.find((r) => r.status !== "SKIPPED");
        out.push({
          name: s.name, everyMs: s.everyMs, nextRun: new Date(dueAt(s.everyMs, at) + s.everyMs).toISOString(),
          last: last ? { id: last.workflowID, status: last.status, scheduledTime: new Date(Number(wfInput(last).scheduledTime)).toISOString(), output: last.output, error: last.error ?? null } : null,
        });
      }
      return out;
    },
    async scheduleRuns(name, limit = 20) {
      if (!schedules.has(name)) throw Object.assign(new Error(`no schedule named ${name}`), { status: 404 });
      const rows = await DBOS.listWorkflows({ workflowName: tickName(name), limit, sortDesc: true, loadInput: true, loadOutput: true });
      return rows.map((r) => ({
        id: r.workflowID, status: r.status, scheduledTime: new Date(Number(wfInput(r).scheduledTime)).toISOString(),
        startedAt: r.createdAt, finishedAt: r.status === "PENDING" ? null : (r.updatedAt ?? null),
        updatedAt: r.updatedAt ?? r.createdAt, output: r.output, error: r.error ?? null,
      }));
    },
    async startWorkflow(name, id, input) {
      await ready();
      const h = await DBOS.startWorkflow(dbosFn(name), { workflowID: id })({ ...input, __id: id });
      return await h.getResult();
    },
    startWorkflowOnce: startOnce,
    async listNamed(name, limit = 100) {
      const rows = await DBOS.listWorkflows({ workflowName: name, limit, sortDesc: true, loadInput: true, loadOutput: true });
      return rows.map((r) => mapStatus(r));
    },
    pending: pendingIds,
    async recover() {
      await ready(); // launch() already recovered PENDING workflows
      return await pendingIds();
    },
    async send(workflowId, topic, value, { dedupe = null } = {}) {
      await ready();
      if (dedupe) {
        const { rowCount } = await pool.query("INSERT INTO ai_collab.dedupe(key, created_at) VALUES ($1, $2) ON CONFLICT DO NOTHING", [dedupe, now()]);
        if (!rowCount) return false;
      }
      // A send racing its own workflow start: DBOS rejects unknown destinations, so retry briefly.
      for (let attempt = 0; ; attempt++) {
        try { await DBOS.send(workflowId, value, topic); break; }
        catch (error) {
          const code = (error as { dbosErrorCode?: number } | null)?.dbosErrorCode;
          if (code !== 16 || attempt >= 20) throw error;
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      return true;
    },
    status: statusRow,
    async result(id) {
      await ready();
      const h = await DBOS.retrieveWorkflow<WfValue>(id);
      return await h.getResult();
    },
    async cancel(id) { await ready(); await DBOS.cancelWorkflow(id); },
    async steps(id) {
      await ready();
      const rows = (await DBOS.listWorkflowSteps(id)) ?? [];
      return rows.map((s: StepRow) => ({ seq: s.functionID, name: s.name, status: s.error ? "error" : "done", output: s.output, error: s.error ?? null }));
    },
    async getKv(key) {
      const { rows } = await pool.query("SELECT value FROM ai_collab.kv WHERE key = $1", [key]);
      return rows.length ? JSON.parse(String(rows[0].value)) : undefined;
    },
    async setKv(key, value) {
      await pool.query("INSERT INTO ai_collab.kv(key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, JSON.stringify(value ?? null)]);
    },
    async prune(names, before) {
      const rows = await DBOS.listWorkflows({ workflowName: names, status: ["SUCCESS", "ERROR", "CANCELLED"], completedBefore: new Date(before).toISOString() });
      if (rows.length) await DBOS.deleteWorkflows(rows.map((r) => r.workflowID));
      return rows.length;
    },
    async drain(workflowId, topic) {
      const { rows } = await pool.query("SELECT message FROM dbos.notifications WHERE destination_uuid = $1 AND topic = $2 AND consumed = false ORDER BY created_at_epoch_ms", [workflowId, topic]);
      // Peek only: consuming is DBOS's job (recv inside the workflow); the caller hands the values to a new run.
      return rows.map((r: { message: string }) => {
        const raw = JSON.parse(String(r.message));
        return raw && typeof raw === "object" && raw.__dbos_serializer ? raw.json : raw;
      });
    },
    pendingCount,
    async close() {
      for (const s of schedules.values()) if (s.timer) clearTimeout(s.timer);
      closing.abort(new Error("workflows closed"));
      if (launched) await DBOS.shutdown({ workflowCompletionTimeoutMS: 5000 });
      await pool.end();
    },
  };
}
