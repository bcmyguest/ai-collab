#!/usr/bin/env node
// ai-collab-bus entry: the local message bus that replaces the ntfy container.
// Reads url/token from defaults.json (or AI_COLLAB_BUS_* env), serves SQLite-backed events on loopback,
// and prunes past retention hourly. Sandboxes reach it through host.openshell.internal, same as ntfy.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { configDir, listProjects, loadProjects, stateDir } from "../lib/config.mjs";
import { DEFAULT_RETENTION_MS, openBus, resolveBusStoreKind } from "../lib/bus.mjs";
import { openPostgresBusStore } from "../lib/bus-postgres.mjs";
import { pgUrl } from "../lib/postgres.mjs";
import { listOwned, listSessions } from "../lib/sessions.mjs";
import { threadSessionsOf } from "../lib/threads.mjs";

function busToken(env) {
  if (env.AI_COLLAB_BUS_TOKEN !== undefined) return env.AI_COLLAB_BUS_TOKEN.trim();
  let file = env.AI_COLLAB_BUS_TOKEN_FILE;
  if (!file) {
    try {
      const defaults = JSON.parse(readFileSync(path.join(configDir(env), "defaults.json"), "utf8"));
      if (typeof defaults.tokenFile === "string") file = defaults.tokenFile;
    } catch { /* no defaults.json */ }
  }
  if (!file) return "";
  try { return readFileSync(file, "utf8").trim(); } catch { return ""; }
}

function busDefaults(env) {
  try {
    return JSON.parse(readFileSync(path.join(configDir(env), "defaults.json"), "utf8"));
  } catch {
    return {};
  }
}

function busPort(env) {
  if (env.AI_COLLAB_BUS_PORT) return Number(env.AI_COLLAB_BUS_PORT);
  try {
    const defaults = JSON.parse(readFileSync(path.join(configDir(env), "defaults.json"), "utf8"));
    if (typeof defaults.url === "string") return new URL(defaults.url).port ? Number(new URL(defaults.url).port) : 8794;
  } catch { /* no defaults.json */ }
  return 8794;
}

/** The thread backfill (docs/threads.md): every registered project's unassigned sessions get a thread. Idempotent. */
export async function backfillThreads(threads, env, log) {
  const roots = new Map(listProjects(env).map((entry) => [entry.project, entry.root]));
  for (const cfg of loadProjects(env, { host: "operator" })) {
    const root = roots.get(cfg.project) || "";
    try {
      const sessions = threadSessionsOf({ sessions: listSessions(cfg), owned: listOwned(cfg), root });
      const { assigned, created } = await threads.sync({ project: cfg.project, root, sessions });
      if (assigned.length) log(`threads: ${cfg.project}: ${assigned.length} session(s) assigned, ${created} thread(s) created`);
    } catch (error) {
      log(`threads: ${cfg.project}: backfill failed: ${error.message}`);
    }
  }
}

export async function main(env = process.env) {
  const log = (message) => process.stderr.write(`ai-collab-bus: ${message}\n`);
  const token = busToken(env);
  if (!token) {
    log("no token: set tokenFile in defaults.json, or AI_COLLAB_BUS_TOKEN / AI_COLLAB_BUS_TOKEN_FILE");
    return 1;
  }
  const dataDir = env.AI_COLLAB_BUS_DATA || path.join(stateDir(env), "bus");
  const retentionMs = Number(env.AI_COLLAB_BUS_RETENTION_HOURS ? Number(env.AI_COLLAB_BUS_RETENTION_HOURS) * 3_600_000 : DEFAULT_RETENTION_MS);
  const kind = resolveBusStoreKind(env, busDefaults(env));
  const store = kind === "postgres"
    ? await openPostgresBusStore({ url: pgUrl(env), filesDir: path.join(dataDir, "files"), retentionMs, log })
    : undefined;
  if (store?.threads) await backfillThreads(store.threads, env, log);
  const bus = openBus({ dataDir, token, retentionMs, baseUrl: env.AI_COLLAB_BUS_BASE_URL || "", store });
  const port = busPort(env);
  const url = await bus.listen(port, "127.0.0.1");
  const prune = async () => { try { const { events, files } = await bus.prune(); if (events || files) log(`pruned ${events} event(s), ${files} file(s)`); } catch (error) { log(`prune failed: ${error.message}`); } };
  await prune();
  const timer = setInterval(prune, 3_600_000);
  timer.unref?.();
  log(`listening on ${url}; store ${kind}; data ${dataDir}; retention ${Math.round(retentionMs / 3_600_000)}h`);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await bus.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
