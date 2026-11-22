// The Cursor adapter keeps an ACP error's code and data and the child's stderr tail, and lib/limits.mjs classifies them.
// A fake cursor-agent speaks ACP; no real CLI, account or sandbox runs.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EventType } from "@ag-ui/core";
import cursorAdapter, { errorText } from "../runner/adapters/cursor.mjs";
import { limitFromRunError } from "../lib/limits.mjs";
import { eventProblem } from "../runner/contract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "helpers", "fake-cursor-agent-fail.mjs");
chmodSync(FAKE, 0o755);

function sandboxEnv(fail, extra = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-cursor-fail-"));
  const root = path.join(home, "demo");
  mkdirSync(root);
  return {
    home, root,
    env: {
      PATH: process.env.PATH, HOME: home, AI_COLLAB_CURSOR_BIN: FAKE, FAKE_CURSOR_FAIL: fail,
      FAKE_CURSOR_LOG: path.join(home, "cursor.log"), ...extra,
    },
  };
}

function ctxFor() {
  const events = [];
  const logs = [];
  return { events, logs, emit: (e) => events.push(e), log: (m) => logs.push(m), signal: new AbortController().signal };
}

async function until(check, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const readLines = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

async function failedRun(t, fail, extra = {}) {
  const t0 = sandboxEnv(fail, extra);
  const adapter = cursorAdapter({ env: t0.env });
  const ctx = ctxFor();
  const options = { project: "demo", cwd: t0.root, permissionMode: "supervised", permission: { force: false }, place: "folder", env: t0.env };
  try {
    const handle = await adapter.open(options, ctx);
    const { runId } = await handle.send({ text: "go" });
    const error = await until(() => ctx.events.find((e) => e.type === EventType.RUN_ERROR), "RUN_ERROR");
    await handle.close();
    return { error, runId, logs: ctx.logs, env: t0.env };
  } finally {
    await adapter.shutdown();
  }
}

test("an ACP error keeps its code and data, and the limit classifier reads them", async (t) => {
  const { error, runId } = await failedRun(t, "acp-error");
  assert.equal(error.metadata.aiCollab.runId, runId);
  assert.equal(eventProblem(error), null);
  // The code and the data's fields are in the runner-visible message and in the metadata.
  assert.match(error.message, /provider error: weekly usage limit reached/);
  assert.match(error.message, /-32000/);
  assert.match(error.message, /"status":429/);
  assert.equal(error.metadata.aiCollab.code, -32000);
  const limit = limitFromRunError("cursor", error.message, error.metadata.aiCollab);
  assert.equal(limit?.harness, "cursor");
  assert.equal(limit?.window, "seven_day", "the window comes from the ACP data too");
  assert.equal(limit?.verified, false);
  assert.equal(limit?.wording, true);
});

test("a structured ACP error code names a limit even with generic message text", async (t) => {
  const { error } = await failedRun(t, "structured-code");
  assert.equal(error.metadata.aiCollab.code, "usage_limit_exceeded");
  const limit = limitFromRunError("cursor", error.message, error.metadata.aiCollab);
  assert.equal(limit?.harness, "cursor");
  assert.equal(limit?.source, "UNVERIFIED ACP error code");
  assert.equal(limit?.wording, true);
});

test("a process that exits keeps a stderr tail, and the limit text in it is classified", async (t) => {
  const { error } = await failedRun(t, "stderr-exit");
  assert.match(error.message, /cursor-agent acp exited \(code 1\)/);
  assert.match(error.message, /You've reached your usage limit for the 5-hour window/);
  assert.match(error.message, /HTTP 429 Too Many Requests/);
  const limit = limitFromRunError("cursor", error.message, error.metadata.aiCollab);
  assert.equal(limit?.harness, "cursor");
  assert.equal(limit?.window, "five_hour");
  assert.equal(limit?.verified, false);
});

test("an exit with no limit wording stays an ordinary run error", async (t) => {
  const { error } = await failedRun(t, "stderr-exit", { FAKE_CURSOR_STDERR: "cursor-agent: could not read config\n" });
  assert.match(error.message, /cursor-agent acp exited \(code 1\)/);
  assert.equal(limitFromRunError("cursor", error.message, error.metadata.aiCollab), null);
});

test("errorText joins the message, code, data and stderr tail", () => {
  const error = Object.assign(new Error("boom"), { code: "usage_limit", data: { a: 1 }, stderr: "tail text" });
  assert.equal(errorText(error), 'boom\nusage_limit\n{"a":1}\ntail text');
  assert.equal(errorText(new Error("plain")), "plain");
  assert.equal(errorText(undefined), "");
});
