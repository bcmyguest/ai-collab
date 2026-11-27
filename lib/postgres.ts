/**
 * Local Postgres for the DBOS workflow engine (workflowEngine: "dbos"). The container is defined in
 * deploy/postgres/compose.yaml and bound to loopback only; the password lives in ~/.config/ai-collab/pg-password
 * (0600) and the data under ~/.local/state/ai-collab/postgres, both owned by the user.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export type RunResult = { code: number; stdout: string; stderr: string };
export type PgPassword = { file: string; password: string; created: boolean };
type Run = (cmd: string, args: string[]) => RunResult;

/** The password file path: AI_COLLAB_PG_PASSWORD_FILE, else <config dir>/pg-password. */
export function pgPasswordFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AI_COLLAB_PG_PASSWORD_FILE) return env.AI_COLLAB_PG_PASSWORD_FILE;
  const configHome = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");
  return path.join(configHome, "ai-collab", "pg-password");
}

/** Creates the Postgres password file (0600) if absent; never overwrites. Returns {file, password, created}. */
export function ensurePgPassword({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}): PgPassword {
  const file = pgPasswordFile(env);
  if (fs.existsSync(file)) {
    if ((fs.statSync(file).mode & 0o777) !== 0o600) fs.chmodSync(file, 0o600); // never leave a password world-readable
    return { file, password: fs.readFileSync(file, "utf8").trim(), created: false };
  }
  const bytes = randomBytes(24);
  let password = "";
  for (const b of bytes) password += ALPHABET[b % ALPHABET.length];
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, password, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { file, password, created: true };
}

/** The DBOS system database URL: loopback, user ai_collab, password from the file, database from
 * AI_COLLAB_PG_DATABASE (default ai_collab; tests use ai_collab_test). */
export function pgUrl(env: NodeJS.ProcessEnv = process.env): string {
  const { password } = ensurePgPassword({ env });
  const database = env.AI_COLLAB_PG_DATABASE || "ai_collab";
  return `postgres://ai_collab:${password}@${env.AI_COLLAB_PG_HOST || "127.0.0.1"}:${env.AI_COLLAB_PG_PORT || "5432"}/${database}`;
}

/**
 * Creates the AI_COLLAB_PG_DATABASE database when missing, through the "postgres" maintenance database.
 * Idempotent, so parallel test files may all call it. Returns the database name.
 * pg is imported lazily: lib/*.mjs must import only builtins at load time (test/plugin-no-deps).
 */
export async function ensureDatabase(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const database = env.AI_COLLAB_PG_DATABASE || "ai_collab";
  if (!/^[a-z_][a-z0-9_]*$/.test(database)) throw new Error(`postgres: invalid database name ${database}`);
  const { password } = ensurePgPassword({ env });
  const { default: pg } = await import("pg");
  const admin = new pg.Pool({ connectionString: `postgres://ai_collab:${password}@${env.AI_COLLAB_PG_HOST || "127.0.0.1"}:${env.AI_COLLAB_PG_PORT || "5432"}/postgres` });
  try {
    const { rows } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
    if (!rows.length) {
      try { await admin.query(`CREATE DATABASE ${database}`); }
      catch (error) { if (!/already exists/.test(String((error as Error | null)?.message))) throw error; } // parallel creators: one wins
    }
  } finally {
    await admin.end();
  }
  return database;
}

/** Postgres reachable? Exits non-zero when the container is down or the port is closed.
 * Probes host:port only: a check must never create the password file pgUrl would read. */
export function pgReachable(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const host = env.AI_COLLAB_PG_HOST || "127.0.0.1";
  const port = Number(env.AI_COLLAB_PG_PORT || "5432");
  return new Promise<boolean>((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(1500);
    sock.on("connect", () => done(true));
    sock.on("error", () => done(false));
    sock.on("timeout", () => done(false));
  });
}

/**
 * `ai-collab postgres <up|down|status>`: drives docker compose on deploy/postgres/compose.yaml.
 * run and composeFile are injectable for tests. Returns an exit code.
 */
export function postgresCommand(argv: string[] = [], { env = process.env, run = defaultRun, composeFile = defaultComposeFile() }: { env?: NodeJS.ProcessEnv; run?: Run; composeFile?: string } = {}): number {
  const sub = argv[0] || "status";
  // oxlint-disable-next-line quality/no-known-value-widening -- looked up by the runtime subcommand
  const args = ({ up: ["compose", "-f", composeFile, "up", "-d"], down: ["compose", "-f", composeFile, "down"], status: ["compose", "-f", composeFile, "ps"] } as Record<string, string[] | undefined>)[sub];
  if (!args) { process.stderr.write(`postgres: unknown command ${sub}; use up, down or status\n`); return 2; }
  if (sub === "up") ensurePgPassword({ env });
  const r = run("docker", args);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.code !== 0) process.stderr.write(r.stderr || `postgres: docker ${sub} failed\n`);
  return r.code;
}

function defaultComposeFile(): string {
  return path.join(path.dirname(new URL(import.meta.url).pathname), "..", "deploy", "postgres", "compose.yaml");
}

function defaultRun(cmd: string, args: string[]): RunResult {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || String(r.error?.message || "") };
}
