// Codex adapter: a timed-out turn/start is flagged as possibly started, shutdown kills a child still starting,
// and steer/interrupt after the session's child is gone return a clear error.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventType } from "@ag-ui/core";
import { permissionSettings } from "../runner/contract.mjs";
import codexAdapter from "../runner/adapters/codex.mjs";

const HELPER = fileURLToPath(new URL("./helpers/fake-codex-silent-app-server.mjs", import.meta.url));
const command = { file: process.execPath, args: [HELPER, "app-server"], version: ["--version"] };

function fakeCtx() {
  const events = [];
  return { events, emit: (e) => events.push(e), log: () => {}, signal: new AbortController().signal };
}

function openOptions(mode, extra = {}) {
  return {
    project: "p", cwd: os.tmpdir(), place: "folder", permissionMode: "auto", permission: permissionSettings("codex", "auto", "folder").settings,
    env: { PATH: process.env.PATH, FAKE_SILENT_MODE: mode, ...extra },
  };
}

test("a turn/start that times out is flagged as possibly started, so the caller never resends it", async () => {
  const adapter = codexAdapter({ command, requestMs: 500 });
  try {
    const handle = await adapter.open(openOptions("silent-turn"), fakeCtx());
    await assert.rejects(handle.send({ text: "hello" }), (error) => {
      assert.match(error.message, /turn\/start timed out/);
      assert.equal(error.mayHaveStarted, true);
      return true;
    });
    await handle.close();
  } finally {
    await adapter.shutdown();
  }
});

test("shutdown kills a codex child that is still starting, so its open fails at once", async () => {
  const log = path.join(mkdtempSync(path.join(os.tmpdir(), "codex-silent-")), "started.log");
  const adapter = codexAdapter({ command, requestMs: 60_000 });
  const opening = adapter.open(openOptions("silent-init", { FAKE_SILENT_LOG: log }), fakeCtx());
  opening.catch(() => {});
  const end = Date.now() + 4000;
  while (!existsSync(log) && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  assert.equal(existsSync(log), true, "the child started");
  await adapter.shutdown();
  await assert.rejects(opening, /app-server exited/);
});

test("steer after the session closed while its turn was running returns a clear error, not a TypeError", async () => {
  const adapter = codexAdapter({ command, requestMs: 1000 });
  try {
    const handle = await adapter.open(openOptions("started"), fakeCtx());
    await handle.send({ text: "work" });
    await handle.close();
    await assert.rejects(handle.steer({ text: "more" }), (error) => {
      assert.equal(error instanceof TypeError, false);
      assert.match(error.message, /not running/);
      return true;
    });
    await assert.rejects(handle.interrupt(), (error) => {
      assert.equal(error instanceof TypeError, false);
      assert.match(error.message, /not running/);
      return true;
    });
  } finally {
    await adapter.shutdown();
  }
});

test("steer after the child crashed returns a clear error, not a TypeError", async () => {
  const adapter = codexAdapter({ command, requestMs: 1000 });
  const ctx = fakeCtx();
  try {
    const handle = await adapter.open(openOptions("crash-after-start"), ctx);
    await handle.send({ text: "crash" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(ctx.events.some((e) => e.type === EventType.RUN_ERROR), true, "the crash ends the run");
    await assert.rejects(handle.steer({ text: "more" }), (error) => {
      assert.equal(error instanceof TypeError, false);
      assert.match(error.message, /no codex turn is running|not running/);
      return true;
    });
  } finally {
    await adapter.shutdown();
  }
});
