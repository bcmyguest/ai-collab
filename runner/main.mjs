#!/usr/bin/env node
// ai-collab-runner entry: loads projects and adapters, recovers durable sessions, serves the control socket.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { loadProjects, stateDir } from "../lib/config.mjs";
import { HARNESSES } from "./contract.mjs";
import { openDurable } from "./durable.mjs";
import { createRunner } from "./runner.mjs";
import { listenControl, runnerSocket } from "./control.mjs";
import { loadSchedules, registerSchedules } from "./schedules.mjs";

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
  const names = String(env.AI_COLLAB_RUNNER_HARNESSES || HARNESSES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const adapters = await loadAdapters(names, { env, log });
  const durable = openDurable(runnerDb(env));
  // Registered before boot so PENDING ticks recover with the sessions.
  const schedules = registerSchedules(durable, loadSchedules(env), { env, log });
  const runner = createRunner({ projects, adapters, durable, env, log });
  const recovered = await runner.boot();
  durable.startSchedules();
  const control = await listenControl(runner, runnerSocket(env));
  log(`listening on ${control.path}; adapters ${[...adapters.keys()].join(", ") || "none"}; recovered ${recovered.length} session(s); schedules ${schedules.join(", ") || "none"}`);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await control.close();
    await runner.stop();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
