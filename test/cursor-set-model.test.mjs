// The Cursor adapter sends session/set_model with the ACP params; the fake agent does not serve it, so the call fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cursorAdapter from "../runner/adapters/cursor.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CURSOR = path.join(HERE, "helpers", "fake-cursor-agent.mjs");
const OPENSHELL = path.join(HERE, "helpers", "fake-openshell.mjs");
chmodSync(CURSOR, 0o755);
chmodSync(OPENSHELL, 0o755);

test("setModel sends session/set_model with the session id and modelId", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-cursor-model-"));
  const root = path.join(home, "demo");
  mkdirSync(root);
  const log = path.join(home, "cursor.log");
  const env = {
    PATH: process.env.PATH, HOME: home, AI_COLLAB_CURSOR_BIN: CURSOR, AI_COLLAB_OPENSHELL_BIN: OPENSHELL,
    FAKE_CURSOR_LOG: log, FAKE_OPENSHELL_LOG: path.join(home, "openshell.log"), FAKE_OPENSHELL_STATE: path.join(home, "openshell.json"),
    FAKE_SANDBOX_CURSOR_BIN: CURSOR,
  };
  const events = [];
  const ctx = { events, logs: [], emit: (e) => events.push(e), log: () => {}, signal: new AbortController().signal };
  const adapter = cursorAdapter({ env });
  try {
    const handle = await adapter.open({ project: "demo", cwd: root, permissionMode: "supervised", permission: { force: false }, place: "folder", env }, ctx);
    await assert.rejects(handle.setModel("composer-2.5"), /unknown session\/set_model/);
    const rpc = readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).find(e => e.kind === "rpc" && e.method === "session/set_model");
    assert.deepEqual(rpc.params, { sessionId: "fake-cursor-session", modelId: "composer-2.5" });
    await handle.close();
  } finally {
    await adapter.shutdown();
  }
  assert.equal(existsSync(log), true);
});
