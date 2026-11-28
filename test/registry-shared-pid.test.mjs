import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sessionLabel } from "../lib/config.ts";
import { processStart } from "../lib/process.ts";
import { listSessions, SHARED_PROCESS_IDLE_MS } from "../lib/sessions/registry.ts";

test("an OpenCode session on the shared live service pid is online only while recently active", (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "aic-shared-pid-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const dir = join(stateDir, "p", "registry");
  mkdirSync(dir, { recursive: true });
  const proc = { pid: process.pid, pidStart: processStart(process.pid) };
  const write = (peer, native, harness, seenAt) => {
    const id = `${peer}#${sessionLabel(native)}`;
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, sessionId: native, cwd: "/tmp", harness, event: "x", seenAt, ...proc }));
    return id;
  };
  const now = Date.now();
  const fresh = write("opencode", "ses_fresh", "opencode", now - 60_000);
  const stale = write("opencode", "ses_stale", "opencode", now - SHARED_PROCESS_IDLE_MS - 60_000);
  const claude = write("claude", "claude-old", "claude", now - 7 * 86_400_000);
  const online = Object.fromEntries(listSessions({ stateDir, project: "p", peers: [] }).map((s) => [s.id, s.online]));
  assert.deepEqual(online, { [fresh]: true, [stale]: false, [claude]: true });
});
