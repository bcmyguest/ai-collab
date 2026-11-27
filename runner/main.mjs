#!/usr/bin/env node
// ai-collab-runner entry: loads projects and adapters, recovers durable sessions, serves the control socket.
import { mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { loadProjects, stateDir, autoDefaults, autoDeployEnabled } from "../lib/config.mjs";
import { autoDeployEntry } from "../lib/land.mjs";
import { HARNESSES } from "./contract.mjs";
import { openWorkflows } from "../lib/workflows.ts";
import { pgUrl } from "../lib/postgres.ts";
import { createRunner } from "./runner.mjs";
import { listenControl, runnerSocket } from "./control.mjs";
import { loadSchedules, registerSchedules } from "./schedules.mjs";
import { startTaskWakes } from "./task-wake.mjs";
import { acquireLock } from "./lock.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The durable log path: AI_COLLAB_RUNNER_DB, else <state dir>/runner.db. */
export const runnerDb = (env = process.env) => env.AI_COLLAB_RUNNER_DB || join(stateDir(env), "runner.db");

/** Imports runner/adapters/<harness>.mjs for each name; a missing module is skipped and reported. */
export async function loadAdapters(names, { dir = join(HERE, "adapters"), env = process.env, log = () => {} } = {}) {
  const adapters = new Map();
  for (const harness of names) {
    if (!HARNESSES.includes(harness)) { log(`unknown harness ${harness}`); continue; }
    let factory;
    try {
      ({ default: factory } = await import(pathToFileURL(join(dir, `${harness}.mjs`)).href));
    } catch (error) {
      if (error.code === "ERR_MODULE_NOT_FOUND") { log(`no ${harness} adapter yet`); continue; }
      throw error;
    }
    const adapter = factory({ env, stateDir: stateDir(env) });
    if (adapter?.harness !== harness) throw new Error(`adapters/${harness}.mjs returned no ${harness} adapter`);
    adapters.set(harness, adapter);
  }
  return adapters;
}

/** Runs the service until SIGTERM or SIGINT. */
export async function main(env = process.env) {
  const log = (message) => process.stderr.write(`ai-collab-runner: ${message}\n`);
  // "runner" names only the base config; sessions publish as their harness.
  const projects = loadProjects(env, { host: "runner" });
  if (!projects.length) log("no enabled project; serving the control socket only");
  const names = env.AI_COLLAB_RUNNER_HARNESSES === "none" ? [] : String(env.AI_COLLAB_RUNNER_HARNESSES || HARNESSES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const adapters = await loadAdapters(names, { dir: env.AI_COLLAB_RUNNER_ADAPTER_DIR || join(HERE, "adapters"), env, log });
  const db = runnerDb(env);
  mkdirSync(dirname(db), { recursive: true, mode: 0o700 });
  const release = acquireLock(join(dirname(db), "runner.lock"));
  let durable;
  let runner;
  let control;
  try {
    // "dbos" runs the workflows on Postgres (ai-collab postgres up); the sqlite durable log stays the default.
    const engine = env.AI_COLLAB_WORKFLOW_ENGINE || autoDefaults(env)?.workflowEngine || "sqlite";
    durable = await openWorkflows({ engine, file: db, log, ...(engine === "dbos" ? { pgUrl: pgUrl(env) } : {}) });
    // Registered before boot so PENDING ticks recover with the sessions; invalid entries are reported, not fatal.
    const { entries: configured, errors } = loadSchedules(env);
    // The auto-deploy schedule exists only when autoDeploy is on (AI_COLLAB_AUTO_DEPLOY or defaults.json).
    const entries = autoDeployEnabled(env) ? [...configured, autoDeployEntry()] : configured;
    for (const error of errors) log(`schedule skipped: ${error}`);
    const schedules = registerSchedules(durable, entries, { env, log });
    runner = createRunner({ projects, adapters, durable, env, log, scheduleErrors: errors, scheduleEntries: entries });
    const recovered = await runner.boot();
    // Serve the socket before any tick can start, so a failed bind starts nothing.
    control = await listenControl(runner, runnerSocket(env));
    await durable.startSchedules();
    startTaskWakes(entries, runner, { env, log });
    log(`listening on ${control.path}; adapters ${[...adapters.keys()].join(", ") || "none"}; recovered ${recovered.length} session(s); schedules ${schedules.join(", ") || "none"}`);
  } catch (error) {
    await control?.close();
    if (runner) await runner.stop();
    else await durable?.close();
    release();
    throw error;
  }
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await control.close();
    await runner.stop();
    release();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
