import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { waitForIdle } from "../lib/agents.mjs";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { sessionIdleState } from "../lib/idle.mjs";
import { listSessions, recordSession } from "../lib/sessions.mjs";
import { sessionState } from "../web/lib/session-state.js";
import { taskBoard } from "../web/server/task-board.mjs";

const cli = fileURLToPath(new URL("../scripts/ai-collab.mjs", import.meta.url));

test("job run reports the child until exit and preserves its exit code", async t => {
  const home = mkdtempSync(join(tmpdir(), "ai-collab-job-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const id = "job-test";
  const env = {
    HOME: home, AI_COLLAB_STATE_DIR: join(home, "state"), AI_COLLAB_PROJECT: "demo",
    AI_COLLAB_PEER: "codex", AI_COLLAB_SESSION: sessionLabel(id),
  };
  const cfg = loadConfig(env, { cwd: home });
  await recordSession(cfg, { id, cwd: home, harness: "codex", event: "Stop" });
  const child = spawn(process.execPath, [cli, "job", "run", "--", process.execPath, "-e",
    'process.stdin.resume(); process.stdin.once("end", () => process.exit(7)); console.log("ready");'],
  { cwd: home, env });
  t.after(() => child.stdin.end());
  const exited = once(child, "exit");
  const [ready] = await once(child.stdout, "data");
  assert.equal(String(ready).trim(), "ready");
  const [session] = listSessions(cfg);
  assert.equal(session.runningJobs, 1);
  assert.equal(await sessionIdleState(session), "busy");
  assert.equal(sessionState(session, Date.now()), "working");
  assert.deepEqual(await waitForIdle(cfg, session.id, { seconds: 0 }), { status: "timeout", address: session.id });
  const board = { list: () => [{ id: "build", status: "building", owner: session.id, progress: [] }] };
  assert.equal(taskBoard(board, [session]).tasks[0].ownerRunningJobs, 1);

  child.stdin.end();
  assert.deepEqual(await exited, [7, null]);
  const [finished] = listSessions(cfg);
  assert.equal(finished.runningJobs, undefined);
  assert.equal(taskBoard(board, [finished]).tasks[0].ownerRunningJobs, undefined);
  assert.deepEqual(await waitForIdle(cfg, session.id, { seconds: 0 }), { status: "ended", address: session.id });
});
