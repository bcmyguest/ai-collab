// Postgres deployment for the DBOS engine: password file, compose file, and the setup command.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ensurePgPassword, pgUrl, postgresCommand } from "../lib/postgres.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPOSE = path.join(HERE, "..", "deploy", "postgres", "compose.yaml");

const tmp = () => mkdtempSync(path.join(tmpdir(), "aic-pg-"));

test("setup creates the password file once, mode 0600", () => {
  const home = tmp();
  const env = { HOME: home };
  const first = ensurePgPassword({ env });
  assert.ok(first.created);
  assert.match(readFileSync(first.file, "utf8"), /^[A-Za-z0-9]{24}$/);
  assert.equal(statSync(first.file).mode & 0o777, 0o600);
  const second = ensurePgPassword({ env });
  assert.ok(!second.created);
  assert.equal(second.password, first.password);
});

test("the compose file pins postgres:17 on loopback with the user's paths", () => {
  const yaml = readFileSync(COMPOSE, "utf8");
  assert.match(yaml, /image: postgres:17/);
  assert.match(yaml, /"127\.0\.0\.1:5432:5432"/);
  assert.match(yaml, /\.local\/state\/ai-collab\/postgres/);
  assert.match(yaml, /\.config\/ai-collab\/pg-password/);
  assert.match(yaml, /restart: unless-stopped/);
});

test("pgUrl reads the password from the file", () => {
  const home = tmp();
  const { password, file } = ensurePgPassword({ env: { HOME: home } });
  const url = pgUrl({ HOME: home });
  assert.equal(url, `postgres://ai_collab:${password}@127.0.0.1:5432/ai_collab`);
  assert.ok(existsSync(file));
});

test("postgresCommand drives docker compose with the compose file", () => {
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, args.join(" ")]); return { code: 0, stdout: "", stderr: "" }; };
  const rc = postgresCommand(["up"], { run, env: { HOME: tmp() } });
  assert.equal(rc, 0);
  assert.equal(calls[0][0], "docker");
  assert.match(calls[0][1], new RegExp(`compose -f .*deploy/postgres/compose\\.yaml up -d`));
});
