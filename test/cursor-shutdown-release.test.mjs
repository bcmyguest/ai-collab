// Cursor adapter shutdown waits for the sandbox release a killed CLI starts, so its clone and staging dirs are gone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cursorAdapter from "../runner/adapters/cursor.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CURSOR = path.join(HERE, "helpers", "fake-cursor-agent.mjs");
const OPENSHELL = path.join(HERE, "helpers", "fake-openshell.mjs");
chmodSync(CURSOR, 0o755);
chmodSync(OPENSHELL, 0o755);
const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];

const ctx = () => ({ emit() {}, log() {}, signal: new AbortController().signal });

test("shutdown resolves only after a killed session's sandbox is released and its temp dirs are removed", async (t) => {
  const home = tempDir(t, "ai-collab-cursor-shutdown-");
  const root = path.join(home, "repo");
  const version = path.join(home, "cursor-agent", "versions", "2026.11.22-fake");
  for (const dir of [root, version]) mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--template=", "-b", "main", root]);
  writeFileSync(path.join(root, "host.txt"), "host\n");
  execFileSync("git", ["-C", root, ...ID, "add", "host.txt"]);
  execFileSync("git", ["-C", root, ...ID, "commit", "--quiet", "-m", "init"]);
  writeFileSync(path.join(version, "cursor-agent"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(path.join(version, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // The adapter's own temp dirs go to a private dir, so other test files' dirs never count here.
  const scratch = path.join(home, "tmp");
  mkdirSync(scratch);
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  t.after(() => { process.env.TMPDIR = saved; });
  const env = {
    PATH: process.env.PATH, HOME: home, AI_COLLAB_CURSOR_BIN: CURSOR, AI_COLLAB_OPENSHELL_BIN: OPENSHELL, AI_COLLAB_CURSOR_TREE: version,
    FAKE_CURSOR_LOG: path.join(home, "cursor.log"), FAKE_OPENSHELL_LOG: path.join(home, "openshell.log"),
    FAKE_OPENSHELL_STATE: path.join(home, "openshell.json"), FAKE_SANDBOX_CURSOR_BIN: CURSOR,
  };
  const adapter = cursorAdapter({ env });
  await adapter.open({
    project: "demo", cwd: root, place: "openshell", permissionMode: "full-access", permission: { force: true }, env,
  }, ctx());
  await adapter.shutdown();
  assert.deepEqual(JSON.parse(readFileSync(env.FAKE_OPENSHELL_STATE, "utf8")).sandboxes, [], "the sandbox is deleted before shutdown resolves");
  assert.deepEqual(readdirSync(scratch), [], "no clone, staging or policy dir is left behind");
});
