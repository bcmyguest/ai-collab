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
import { runWithTopContext } from "@dbos-inc/dbos-sdk/internal/context";
import pg from "pg";
import { openDurable } from "./durable.mjs";

/** The DBOS applicationVersion: bump it whenever a workflow's recorded op sequence changes (test/dbos-step-sequences.test.mjs). */
export const DBOS_APP_VERSION = "ai-collab-1";

type Json = Record<string, unknown>;
/** A workflow's result, kv value, or message: the JSON the engines checkpoint verbatim. */
type WfValue = Json | string | number | boolean | null | undefined | WfValue[];
type NowFn = () => number;
type WfFn = (wf: Json, input: Json) => Promise<WfValue>;
type Schedule = { name: string; everyMs: number; firstStep: string | null; timer: ReturnType<typeof setTimeout> | null };
type StepRow = { functionID: number; name: string; output: unknown; error: Error | null };
type StepQuery = (sql: string, params: unknown[]) => Promise<{ rows: { function_name: string }[] }>;

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
export async function openWorkflows(opts: { engine?: string; file?: string } & DbosOpts): Promise<Workflows> {
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

/**
 * A run's recorded op names, read straight from DBOS's operation table: a DBOS.listWorkflowSteps call inside a
 * workflow would itself be recorded and replay stale. Retries a failing query with backoff, then throws: an
 * empty answer would read as "no prior record" and re-run a cut step.
 */
export async function readPriorSteps(query: StepQuery, id: string, { attempts = 5, delayMs = 200, log = () => {} }: { attempts?: number; delayMs?: number; log?: (m: string) => void } = {}): Promise<string[]> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { rows } = await query("SELECT function_name FROM dbos.operation_outputs WHERE workflow_uuid = $1", [id]);
      return rows.map((r) => r.function_name);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      if (attempt >= attempts) throw new Error(`prior steps of ${id} unreadable after ${attempts} attempts: ${why}`, { cause: error });
      log(`workflows: prior step lookup for ${id} failed (attempt ${attempt} of ${attempts}), retrying: ${why}`);
      await new Promise((r) => setTimeout(r, delayMs * 2 ** (attempt - 1)));
    }
  }
}

type DbosOpts = {
  pgUrl?: string; now?: NowFn; log?: (m: string) => void; applicationVersion?: string;
  /** Test seam: replaces the prior-steps query (default: the engine's pool). */
  priorStepsQuery?: StepQuery;
  priorStepsRetry?: { attempts?: number; delayMs?: number };
};

/** The DBOS-backed engine. Same surface as openDurable; every query is async (Postgres). */
async function openDbosEngine({ pgUrl = "", now = Date.now, log = () => {}, applicationVersion = DBOS_APP_VERSION, priorStepsQuery, priorStepsRetry = {} }: DbosOpts): Promise<Workflows> {
  const pool = new pg.Pool({ connectionString: pgUrl, max: 5 });
  const stepQuery: StepQuery = priorStepsQuery ?? ((sql, params) => pool.query(sql, params));
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ai_collab;
    CREATE TABLE IF NOT EXISTS ai_collab.kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_collab.skipped (id TEXT PRIMARY KEY, name TEXT NOT NULL, input TEXT NOT NULL, reason TEXT NOT NULL, created_at BIGINT NOT NULL, app_version TEXT);
    ALTER TABLE ai_collab.skipped ADD COLUMN IF NOT EXISTS app_version TEXT;
    DROP TABLE IF EXISTS ai_collab.started;
    DROP TABLE IF EXISTS ai_collab.dedupe;`);

  const registry = new Map<string, WfFn>();
  const dbosFns = new Map<string, (input: Json) => Promise<WfValue>>();
  const schedules = new Map<string, Schedule>();
  const closing = new AbortController();
  const ctrls = new Map<string, AbortController>(); // one per live run, so cancel() can abort that workflow's signal
  let launched: Promise<void> | null = null;

  // Registration must finish before launch; the runner registers at boot, so launch on first async use.
  function ready(): Promise<void> {
    if (!launched) {
      launched = (async () => {
        for (const name of registry.keys()) if (!dbosFns.has(name)) registerDbos(name);
        await versionGuard();
        // DBOS hashes registered functions into the app version by default; our registrations are one wrapper whose
        // count changes with the code, which would orphan PENDING workflows on every deploy. Pin it instead.
        DBOS.setConfig({ name: "ai-collab", systemDatabaseUrl: pgUrl, applicationVersion });
        await DBOS.launch();
      })();
    }
    return launched;
  }

  // Upgrade rule: DBOS only recovers PENDING runs recorded under the CURRENT applicationVersion, so a
  // bump orphans the old ones (dropped records and reservations). AI_COLLAB_DBOS_VERSION_GUARD: refuse
  // (default: boot fails listing every foreign-version run of our own workflows), drain (cancel them,
  // then boot) or off (the test suite, whose shared database holds stale rows). Bump only after the old fleet drains.
  async function versionGuard(): Promise<void> {
    const mode = process.env.AI_COLLAB_DBOS_VERSION_GUARD || "refuse";
    if (mode !== "refuse" && mode !== "drain") return;
    const names = [...registry.keys()];
    if (!names.length) return;
    let ids: string[];
    try {
      const { rows } = await pool.query(
        "SELECT workflow_uuid FROM dbos.workflow_status WHERE application_version <> $1 AND status IN ('PENDING', 'ENQUEUED') AND name = ANY($2) ORDER BY created_at",
        [applicationVersion, names]);
      ids = rows.map((r: { workflow_uuid: string }) => r.workflow_uuid);
    } catch (error) {
      // A fresh database has no dbos schema until launch() migrates it, so it holds no foreign runs either.
      const code = (error as { code?: string } | null)?.code;
      if (code === "42P01" || code === "3F000") return;
      throw new Error(`workflows: version guard query failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (!ids.length) return;
    if (mode === "refuse") throw new Error(`workflows: ${ids.length} PENDING run(s) recorded under another application version (${ids.join(", ")}); drain the old fleet first, or boot with AI_COLLAB_DBOS_VERSION_GUARD=drain to cancel them`);
    await pool.query("UPDATE dbos.workflow_status SET status = 'CANCELLED', updated_at = $2 WHERE workflow_uuid = ANY($1) AND status IN ('PENDING', 'ENQUEUED')", [ids, now()]);
    log(`workflows: drained ${ids.length} PENDING run(s) recorded under another application version: ${ids.join(", ")}`);
  }

  function registerDbos(name: string): (input: Json) => Promise<WfValue> {
    const wf = registry.get(name);
    if (!wf) throw new Error(`no workflow named ${name}`);
    const fn = DBOS.registerWorkflow(async (input: Json) => {
      const id = String(asJson(input).__id ?? "");
      const ctrl = new AbortController();
      ctrls.set(id, ctrl);
      try {
        // Steps recorded by an earlier life of this run: they mark cuts (started, never finished)
        // and tell the workflow it is replaying. Without them a cut step would re-run (a second harness
        // turn), and a thrown error would record a terminal ERROR: park the run PENDING for the next boot.
        let prior: string[];
        try {
          prior = await readPriorSteps(stepQuery, id, { ...priorStepsRetry, log });
        } catch (error) {
          log(`workflows: ${id} parked PENDING until the next boot: ${error instanceof Error ? error.message : String(error)}`);
          return await new Promise<never>(() => {});
        }
        return await wf(makeContext(id, input, ctrl, prior), input);
      } finally {
        ctrls.delete(id);
      }
    }, { name });
    dbosFns.set(name, fn);
    return fn;
  }

  function makeContext(id: string, input: Json, ctrl: AbortController, prior: string[]) {
    const signal = AbortSignal.any([closing.signal, ctrl.signal]);
    const priorOps = prior.length;
    let consumed = 0; // recorded rows this run issued or replayed: a step 2 (marker + result), a recv 1 or 2, a sleep 0 or 1
    // Cut detection keys on the occurrence, not the name: the runner repeats step names in loops
    // (wake.reserve, wake.send, wake.wait), so a name anywhere in the record says nothing about *this*
    // occurrence. Occurrence k of a name is cut when the record holds >= k markers but < k results.
    const priorMarkers = new Map<string, number>();
    const priorResults = new Map<string, number>();
    for (const n of prior) {
      if (n.endsWith("!started")) priorMarkers.set(n, (priorMarkers.get(n) ?? 0) + 1);
      else priorResults.set(n, (priorResults.get(n) ?? 0) + 1);
    }
    const issued = new Map<string, number>();
    const recvOp = async (topic: string, opts: { timeoutSeconds: number }) => {
      // DBOS records each recv as a DBOS.recv row; a timeout above 0 first records its deadline as a DBOS.sleep row.
      consumed += opts.timeoutSeconds > 0 ? 2 : 1;
      return await DBOS.recv(topic, opts);
    };
    return {
      id, input, signal,
      get replaying() { return consumed < priorOps; },
      step: async (name: string, fn: () => Promise<WfValue>, { onCut }: { onCut?: () => WfValue | Promise<WfValue> } = {}) => {
        // A marker step records that fn started; a marker without a result at context build time is a cut
        // (killed mid-step): onCut answers it once, mirroring the sqlite engine, and fn never re-runs.
        const marker = `${name}!started`;
        const k = (issued.get(name) ?? 0) + 1;
        issued.set(name, k);
        consumed += 1;
        await DBOS.runStep(async () => true, { name: marker });
        consumed += 1;
        if (onCut && k > (priorResults.get(name) ?? 0) && k <= (priorMarkers.get(marker) ?? 0)) {
          return await DBOS.runStep(async () => await onCut(), { name });
        }
        return await DBOS.runStep(fn, { name });
      },
      recv: async (topic: string, { all = false, timeoutSeconds = null } = {}) => {
        if (!all) {
          const first = await recvOp(topic, { timeoutSeconds: 0 });
          if (first !== null) return first;
          for (;;) {
            const next = await recvOp(topic, { timeoutSeconds: 60 });
            if (next !== null) return next;
          }
        }
        // Like the sqlite engine: recv-all waits for the first message, then takes the whole backlog.
        // timeoutSeconds 0 never waits: it returns the backlog, empty included (the wake loop polls).
        const values: unknown[] = [];
        if (timeoutSeconds !== 0) {
          for (;;) {
            const first = await recvOp(topic, { timeoutSeconds: 60 });
            if (first !== null) { values.push(first); break; }
          }
        }
        for (;;) {
          const next = await recvOp(topic, { timeoutSeconds: 0 });
          if (next === null) break;
          values.push(next);
        }
        return values;
      },
      pending: async (topic: string) => await pendingCount(id, topic),
      pause: (ms: number) => new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, Math.max(0, ms));
        function onAbort() { clearTimeout(t); reject(signal.reason); }
        signal.addEventListener("abort", onAbort, { once: true });
      }),
      sleep: async (ms: number) => { consumed += ms > 0 ? 1 : 0; await DBOS.sleep(ms); }, // DBOS records no row for ms <= 0
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

  // A start from inside a workflow is an independent workflow, like on the sqlite engine. DBOS forbids it
  // inside a step (the pattern flow's steps start role sessions), and from a workflow body it records a
  // child start, a DBOS.listWorkflows and a late DBOS.getResult row in the caller (the wake's late handoff),
  // rows `replaying` cannot count. A cleared context makes it a top-level start that records nothing in the
  // caller; the deterministic workflow id keeps a replayed start idempotent.
  function outsideWorkflow<T>(fn: () => Promise<T>): Promise<T> {
    return DBOS.isWithinWorkflow() ? runWithTopContext({}, fn) : fn();
  }

  function startOnce(name: string, id: string, input: Json): Promise<boolean> {
    return outsideWorkflow(() => startOnceTop(name, id, input));
  }

  async function startOnceTop(name: string, id: string, input: Json): Promise<boolean> {
    await ready();
    // Start first: DBOS dedupes by workflowID (a repeat start returns the first run's handle), so no guard row
    // can strand a message when a crash lands between the guard and the start. The pre-check only informs the
    // boolean; two racing callers both reporting "started" is harmless because the workflow itself runs once.
    const existed = Boolean(await statusRow(id));
    const h = await DBOS.startWorkflow(dbosFn(name), { workflowID: id })({ ...input, __id: id });
    h.getResult().catch(() => {});
    return !existed;
  }

  async function pendingIds(): Promise<string[]> {
    await ready();
    const rows = await DBOS.listWorkflows({ status: "PENDING", applicationVersion });
    return rows.filter((r) => registry.has(r.workflowName)).map((r) => r.workflowID);
  }

  // Why a scheduled tick at scheduledTime is skipped for an edited interval, or null.
  async function intervalReason(s: Schedule, scheduledTime: number): Promise<string | null> {
    // No limit before the find: a manual run is the newest row and must not hide the last real tick.
    // Scoped to this application version: PENDING ticks left by an older deploy are orphans for
    // recovery to settle, not runs still going — unscoped they would skip every future tick.
    const rows = await DBOS.listWorkflows({ workflowName: tickName(s.name), applicationVersion, limit: 50, sortDesc: true, loadInput: true });
    const last = rows.find((r) => r.status !== "SKIPPED" && !r.workflowID.includes("@manual@"));
    if (!last) return null;
    const previous = Number(wfInput(last).scheduledTime);
    if (scheduledTime - previous >= s.everyMs) return null;
    return `interval changed: previous tick ${new Date(previous).toISOString()} is under ${s.everyMs} ms earlier`;
  }

  async function fire(s: Schedule, scheduledTime: number, actualTime: number, { manual = false }: { manual?: boolean } = {}): Promise<{ id: string | null; status: string }> {
    if (closing.signal.aborted) return { id: null, status: "closed" };
    await ready();
    const name = tickName(s.name);
    const id = manual ? `${s.name}@manual@${crypto.randomUUID()}` : tickId(s.name, scheduledTime);
    const input = { scheduledTime, actualTime, ...(manual ? { manual: true } : {}) };
    // Mirror the sqlite engine: a tick that finds the previous run still going is skipped, and every
    // skip is recorded. DBOS has no public SKIPPED status, so the mirror table carries the visibility.
    const inflight = await DBOS.listWorkflows({ workflowName: name, status: ["PENDING", "ENQUEUED"], applicationVersion });
    const reason = (!manual && (await intervalReason(s, scheduledTime))) || (inflight.length > 0 && "previous run still going") || null;
    if (reason) {
      await pool.query("INSERT INTO ai_collab.skipped(id, name, input, reason, created_at, app_version) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING", [id, name, JSON.stringify(input), reason, now(), applicationVersion]);
      return { id, status: "skipped" };
    }
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
    register(name, fn) {
      if (launched) throw new Error(`workflow ${name} registered after launch; register before the first async call`);
      registry.set(name, fn);
    },
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
        const rows = await DBOS.listWorkflows({ workflowName: tickName(s.name), applicationVersion, limit: 50, sortDesc: true, loadInput: true, loadOutput: true });
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
      const rows = await DBOS.listWorkflows({ workflowName: tickName(name), applicationVersion, limit, sortDesc: true, loadInput: true, loadOutput: true });
      const real = rows.map((r) => ({
        id: r.workflowID, status: r.status, scheduledTime: new Date(Number(wfInput(r).scheduledTime)).toISOString(),
        startedAt: r.createdAt, finishedAt: r.status === "PENDING" ? null : (r.updatedAt ?? null),
        updatedAt: r.updatedAt ?? r.createdAt, output: r.output, error: r.error ?? null,
      }));
      // DBOS has no public SKIPPED status: skipped ticks live in the mirror table and merge into the list.
      const { rows: skips } = await pool.query("SELECT id, input, reason, created_at FROM ai_collab.skipped WHERE name = $1 AND app_version = $2 ORDER BY created_at DESC LIMIT $3", [tickName(name), applicationVersion, limit]);
      const skipped = skips.map((k: { id: string; input: string; reason: string; created_at: string | number }) => ({
        id: k.id, status: "SKIPPED",
        scheduledTime: new Date(Number(JSON.parse(k.input).scheduledTime)).toISOString(),
        startedAt: null, finishedAt: null, updatedAt: new Date(Number(k.created_at)).toISOString(),
        output: { skipped: k.reason }, error: null,
      }));
      // Newest scheduledTime first; a skip sorts above the run it skipped, like the sqlite engine.
      return [...skipped, ...real].sort((a, b) => Date.parse(String(b.scheduledTime)) - Date.parse(String(a.scheduledTime))).slice(0, limit);
    },
    startWorkflow: (name, id, input) => outsideWorkflow(async () => {
      await ready();
      const h = await DBOS.startWorkflow(dbosFn(name), { workflowID: id })({ ...input, __id: id });
      return await h.getResult();
    }),
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
      // DBOS dedupes a repeat send by idempotencyKey itself, so a failed send never spends the key and a crash
      // after the send cannot lose the message. The boolean is a presence probe on the notification the key
      // names; DBOS scopes its own key per destination, so the probe matches the sqlite engine's global
      // dedupe by looking for the key toward ANY destination. DBOS stores the key as "<key>::<destination>":
      // match that exactly, since a prefix match makes "k" collide with "k:" or "k::x" (an empty session
      // label). If the internal schema ever moves, the probe degrades to "fresh" and delivery stays exactly-once.
      if (dedupe) {
        try {
          const { rows } = await pool.query("SELECT 1 FROM dbos.notifications WHERE message_uuid = $1 || '::' || destination_uuid LIMIT 1", [dedupe]);
          if (rows.length) return false;
        } catch { /* unknown schema: let idempotencyKey enforce dedupe and report fresh */ }
      }
      // A send racing its own workflow start: DBOS rejects unknown destinations, so retry briefly.
      for (let attempt = 0; ; attempt++) {
        try { await DBOS.send(workflowId, value, topic, dedupe ?? undefined); break; }
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
    async cancel(id) {
      await ready();
      // Mark CANCELLED first (deterministic status), then wake the run so it unwinds on its signal.
      await DBOS.cancelWorkflow(id);
      ctrls.get(id)?.abort("cancel");
    },
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
      await ready();
      const rows = await DBOS.listWorkflows({ workflowName: names, status: ["SUCCESS", "ERROR", "CANCELLED"], completedBefore: new Date(before).toISOString() });
      if (rows.length) await DBOS.deleteWorkflows(rows.map((r) => r.workflowID));
      // Skipped-tick mirror rows outlive their visibility window; drop the old ones so the table stays small.
      await pool.query("DELETE FROM ai_collab.skipped WHERE created_at < $1", [before]);
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
