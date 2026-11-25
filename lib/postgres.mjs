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

/** The password file path: AI_COLLAB_PG_PASSWORD_FILE, else <config dir>/pg-password. */
export function pgPasswordFile(env = process.env) {
  if (env.AI_COLLAB_PG_PASSWORD_FILE) return env.AI_COLLAB_PG_PASSWORD_FILE;
  const configHome = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");
  return path.join(configHome, "ai-collab", "pg-password");
}

/** Creates the Postgres password file (0600) if absent; never overwrites. Returns {file, password, created}. */
export function ensurePgPassword({ env = process.env } = {}) {
  const file = pgPasswordFile(env);
  if (fs.existsSync(file)) return { file, password: fs.readFileSync(file, "utf8").trim(), created: false };
  const bytes = randomBytes(24);
  let password = "";
  for (const b of bytes) password += ALPHABET[b % ALPHABET.length];
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, password, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { file, password, created: true };
}

/** The DBOS system database URL: loopback, user ai_collab, password from the file. */
export function pgUrl(env = process.env) {
  const { password } = ensurePgPassword({ env });
  return `postgres://ai_collab:${password}@${env.AI_COLLAB_PG_HOST || "127.0.0.1"}:${env.AI_COLLAB_PG_PORT || "5432"}/ai_collab`;
}

/** Postgres reachable? Exits non-zero when the container is down or the port is closed. */
export function pgReachable(env = process.env) {
  const url = new URL(pgUrl(env));
  return new Promise((resolve) => {
    const sock = net.connect({ host: url.hostname, port: Number(url.port) });
    const done = (ok) => { sock.destroy(); resolve(ok); };
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
export function postgresCommand(argv = [], { env = process.env, run = defaultRun, composeFile = defaultComposeFile() } = {}) {
  const sub = argv[0] || "status";
  const args = { up: ["compose", "-f", composeFile, "up", "-d"], down: ["compose", "-f", composeFile, "down"], status: ["compose", "-f", composeFile, "ps"] }[sub];
  if (!args) { process.stderr.write(`postgres: unknown command ${sub}; use up, down or status\n`); return 2; }
  if (sub === "up") ensurePgPassword({ env });
  const r = run("docker", args);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.code !== 0) process.stderr.write(r.stderr || `postgres: docker ${sub} failed\n`);
  return r.code;
}

function defaultComposeFile() {
  return path.join(path.dirname(new URL(import.meta.url).pathname), "..", "deploy", "postgres", "compose.yaml");
}

function defaultRun(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || String(r.error?.message || "") };
}
