// Codex adapter forwards codexErrorInfo on a failed turn, so the runner can classify a plan limit (fake app-server only).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventType } from "@ag-ui/core";
import codexAdapter, { APP_SERVER_ARGS } from "../runner/adapters/codex.mjs";
import { eventProblem, permissionSettings } from "../runner/contract.mjs";
import { limitFromRunError } from "../lib/limits.mjs";

const FAKE = fileURLToPath(new URL("./helpers/fake-codex-app-server.mjs", import.meta.url));

async function until(check, ms = 5000) {
  const began = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - began > ms) throw new Error("timed out waiting for an event");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a plan-limit turn failure carries codexErrorInfo in RUN_ERROR and classifies as a limit", async () => {
  const events = [];
  const ctx = { emit: (event) => events.push(event), log: () => {}, signal: new AbortController().signal };
  const adapter = codexAdapter({ command: { file: process.execPath, args: [FAKE, ...APP_SERVER_ARGS], version: [FAKE, "--version"] } });
  const env = { PATH: process.env.PATH, FAKE_CODEX_LOG: join(mkdtempSync(join(tmpdir(), "codex-limit-")), "fake.log") };
  try {
    const handle = await adapter.open({ project: "p", cwd: "/tmp", place: "folder", permissionMode: "auto", permission: permissionSettings("codex", "auto", "folder").settings, env }, ctx);
    const { runId } = await handle.send({ text: "limit" });
    const error = await until(() => events.find((e) => e.type === EventType.RUN_ERROR));
    assert.equal(error.metadata.aiCollab.runId, runId);
    assert.equal(error.metadata.aiCollab.codexErrorInfo, "usageLimitExceeded");
    assert.equal(eventProblem(error), null);
    assert.equal(limitFromRunError("codex", error.message, error.metadata.aiCollab)?.verified, false);
  } finally {
    await adapter.shutdown();
  }
});
