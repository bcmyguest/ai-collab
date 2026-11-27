// Every start and wake the runner makes of a managed session passes the hook's SessionStart check; a grandchild does not.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { loadConfig, sessionLabel } from "../lib/config.ts";
import { processStart } from "../lib/process.ts";
import { recordSession } from "../lib/sessions/registry.ts";
import { readOwned } from "../lib/sessions/registry.ts";
import { managedStartAllowed } from "../lib/subagent-guard.ts";
import { openDurable } from "../lib/durable.ts";
import { createRunner, WAKE } from "../runner/runner.ts";
import { createFakeAdapter } from "../runner/adapters/fake.ts";
import { tempDir } from "./helpers/tmp.mjs";

// The state dir is the default one under HOME, so the child's env (which drops AI_COLLAB_*) finds the same records.
function setup(t, fake) {
  const home = tempDir({ after }, "ai-collab-managed-start-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, "demo");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  const state = path.join(home, ".local", "state", "ai-collab");
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), AI_COLLAB_URL: fake.url,
    AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "runner", AI_COLLAB_PEERS: "codex,claude,operator,runner",
    AI_COLLAB_STATE_DIR: state, AI_COLLAB_TIMEOUT_MS: "2000",
  };
  const cfg = loadConfig(env, { cwd: root });
  return { root, env, cfg, db: path.join(state, "runner.db") };
}

async function until(check, what, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const HARNESS = { pid: process.pid, start: processStart(process.pid) };
const GRANDCHILD = { pid: 999_999_999, start: "1" };

// A Codex-style fake: SessionStart runs inside open (before the runner writes the owned record) and inside resume.
function checkingAdapter(ctx) {
  const adapter = createFakeAdapter({ harness: "codex" });
  const checks = [];
  const check = (phase, nativeId, env) => {
    const where = { cwd: ctx.root, host: "codex", session: sessionLabel(nativeId) };
    checks.push({ phase, env, allowed: managedStartAllowed(env, HARNESS), disk: readOwned(ctx.cfg, sessionLabel(nativeId))?.status ?? null });
  };
  const open = adapter.open.bind(adapter);
  adapter.open = async (options, context) => {
    const handle = await open(options, context);
    check("open", handle.nativeId, options.env);
    return handle;
  };
  const resume = adapter.resume.bind(adapter);
  adapter.resume = (record, context, env, staged) => {
    check("resume", record.nativeId, env);
    return resume(record, context, env, staged);
  };
  return { adapter, checks };
}

const direct = (label, body) => JSON.stringify({ v: 1, kind: "msg", from: "operator", to: "codex", toSession: label, operatorThread: true, ts: new Date().toISOString(), body });

test("a managed open, owned wake and adopted wake pass SessionStart; a grandchild with the same env is refused", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const ctx = setup(t, fake);
  const { adapter, checks } = checkingAdapter(ctx);
  const durable = openDurable(ctx.db);
  const runner = createRunner({ projects: [ctx.cfg], adapters: new Map([["codex", adapter]]), durable, env: ctx.env, startGapMs: 0, watch: true, pumpMs: 0 });
  await runner.boot();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const { session, nativeId } = await runner.start({ project: "demo", harness: "codex", prompt: "first", managed: true });
    await until(() => runner.get(session).status === "idle", "idle");
    await runner.close(session);
    await until(() => runner.get(session).status === "ended", "ended");
    const owned = fake.inject("ai-collab-demo--to--codex", direct(sessionLabel(nativeId), "owned wake"));
    await until(() => durable.status(`${WAKE}:${session}:${owned.id}`)?.status === "SUCCESS", "owned wake");

    const member = "codex-thread-detached-member";
    await recordSession({ ...ctx.cfg, peer: "codex", session: sessionLabel(member) }, { id: member, cwd: ctx.root, harness: "codex", event: "stop", managed: true });
    const adopted = fake.inject("ai-collab-demo--to--codex", direct(sessionLabel(member), "adopted wake"));
    await runner.pump();
    await until(() => durable.status(`${WAKE}:codex#${sessionLabel(member)}:${adopted.id}`)?.status === "SUCCESS", "adopted wake");

    assert.deepEqual(checks.map(({ phase, allowed }) => [phase, allowed]), [["open", true], ["resume", true], ["resume", true]]);
    // The record on disk is live before the harness resumes, so the SessionStart check sees what the runner holds.
    assert.deepEqual(checks.filter((c) => c.phase === "resume").map((c) => c.disk), ["idle", "idle"]);
    for (const { env } of checks) {
      assert.equal(managedStartAllowed(env, GRANDCHILD), false);
    }
  } finally {
    await runner.stop();
  }
});
