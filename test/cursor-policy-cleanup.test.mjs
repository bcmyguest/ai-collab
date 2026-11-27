// The Cursor adapter writes its sandbox policy to a private temp dir and removes it when no session needs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cursorAdapter from "../runner/adapters/cursor.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CURSOR = path.join(HERE, "helpers", "fake-cursor-agent.mjs");
const OPENSHELL = path.join(HERE, "helpers", "fake-openshell.mjs");
chmodSync(CURSOR, 0o755);
chmodSync(OPENSHELL, 0o755);

const ctx = () => ({ emit() {}, log() {}, signal: new AbortController().signal });

// A host install tree shaped like the real one, the fake openshell, and an adapter over them.
function lab(t) {
  const home = tempDir(t, "ai-collab-cursor-policy-test-");
  const root = path.join(home, "repo");
  const version = path.join(home, "cursor-agent", "versions", "2026.11.22-fake");
  for (const dir of [root, version]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(root, "host.txt"), "host\n");
  writeFileSync(path.join(version, "cursor-agent"), "#!/bin/sh\nexit 0\n");
  writeFileSync(path.join(version, "node"), "#!/bin/sh\nexit 0\n");
  const env = {
    PATH: process.env.PATH, HOME: home, AI_COLLAB_CURSOR_BIN: CURSOR, AI_COLLAB_OPENSHELL_BIN: OPENSHELL,
    LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH, AI_COLLAB_CURSOR_TREE: version,
    FAKE_CURSOR_LOG: path.join(home, "cursor.log"), FAKE_OPENSHELL_LOG: path.join(home, "openshell.log"),
    FAKE_OPENSHELL_STATE: path.join(home, "openshell.json"), FAKE_SANDBOX_CURSOR_BIN: CURSOR,
  };
  const options = { project: "demo", cwd: root, place: "openshell", permissionMode: "full-access", permission: { force: true }, env };
  return { env, options, adapter: cursorAdapter({ env }) };
}

// The --policy path of each sandbox create the fake openshell logged.
function policies(env) {
  const calls = readFileSync(env.FAKE_OPENSHELL_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return calls.filter((c) => c.includes("--policy")).map((c) => c[c.indexOf("--policy") + 1]);
}

test("closing the last sandbox session removes the policy dir; a later session writes a new one", async (t) => {
  const { env, options, adapter } = lab(t);
  const first = await adapter.open(options, ctx());
  const second = await adapter.open({ ...options, project: "other" }, ctx());
  const [policy] = policies(env);
  assert.ok(existsSync(policy), "the policy file outlives the open call");
  await first.close();
  assert.ok(existsSync(policy), "the policy stays while a session may still use it");
  await second.close();
  assert.equal(existsSync(path.dirname(policy)), false, "the last close removes the policy dir");
  const third = await adapter.open(options, ctx());
  assert.ok(existsSync(policies(env).at(-1)), "a new session gets a fresh policy file");
  await third.close();
  await adapter.shutdown();
});

test("shutdown removes the policy dir of sessions that never closed", async (t) => {
  const { env, options, adapter } = lab(t);
  await adapter.open(options, ctx());
  const [policy] = policies(env);
  assert.ok(existsSync(policy));
  await adapter.shutdown();
  assert.equal(existsSync(path.dirname(policy)), false, "shutdown removes the policy dir");
});
