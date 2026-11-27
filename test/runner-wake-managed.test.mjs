// A runner wake of a managed session keeps native subagents off, whatever the owned record file says.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { recordSession } from "../lib/sessions.mjs";
import { writeOwned } from "../lib/sessions/registry.ts";
import { MANAGED_ENV } from "../lib/subagent-guard.ts";
import { openDurable } from "../runner/durable.mjs";
import { createRunner, WAKE } from "../runner/runner.mjs";
import { createFakeAdapter } from "../runner/adapters/fake.mjs";
import { tempDir } from "./helpers/tmp.mjs";

function setup(t, fake) {
  const home = tempDir({ after }, "ai-collab-wake-managed-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, "demo");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), AI_COLLAB_URL: fake.url,
    AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "runner", AI_COLLAB_PEERS: "codex,claude,operator,runner",
    AI_COLLAB_STATE_DIR: path.join(home, "state"), AI_COLLAB_TIMEOUT_MS: "2000",
  };
  const cfg = loadConfig(env, { cwd: root });
  return { root, env, cfg, db: path.join(home, "state", "runner.db") };
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

// A fake whose resume records the managed flag and env it got.
function recordingAdapter() {
  const adapter = createFakeAdapter({ harness: "codex" });
  const resumed = [];
  const resume = adapter.resume.bind(adapter);
  adapter.resume = (record, ctx, env) => { resumed.push({ managed: record.managed === true, env: env?.[MANAGED_ENV] }); return resume(record, ctx, env); };
  return { adapter, resumed };
}

const direct = (label, body) => JSON.stringify({ v: 1, kind: "msg", from: "operator", to: "codex", toSession: label, operatorThread: true, ts: new Date().toISOString(), body });

for (const managed of [true, false]) {
  test(`an adopted wake of a ${managed ? "managed" : "plain"} detached session resumes it ${managed ? "with" : "without"} the block`, async (t) => {
    const fake = await startFakeNtfy();
    t.after(() => fake.close());
    const ctx = setup(t, fake);
    const { adapter, resumed } = recordingAdapter();
    const durable = openDurable(ctx.db);
    const runner = createRunner({ projects: [ctx.cfg], adapters: new Map([["codex", adapter]]), durable, env: ctx.env, startGapMs: 0, watch: false, pumpMs: 0 });
    await runner.boot();
    try {
      const nativeId = `codex-thread-member-${managed}`;
      const label = sessionLabel(nativeId);
      await recordSession({ ...ctx.cfg, peer: "codex", session: label }, { id: nativeId, cwd: ctx.root, harness: "codex", event: "stop", managed });
      const ev = fake.inject("ai-collab-demo--to--codex", direct(label, "new work"));
      await runner.pump();
      await until(() => durable.status(`${WAKE}:codex#${label}:${ev.id}`)?.status === "SUCCESS", "wake");
      assert.deepEqual(resumed, [{ managed, env: managed ? "1" : undefined }]);
    } finally {
      await runner.stop();
    }
  });
}

test("a later wake of an adopted managed session, after a runner restart, keeps the block", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const ctx = setup(t, fake);
  const nativeId = "codex-thread-member-restart";
  const label = sessionLabel(nativeId);
  await recordSession({ ...ctx.cfg, peer: "codex", session: label }, { id: nativeId, cwd: ctx.root, harness: "codex", event: "stop", managed: true });
  const results = [];
  for (const body of ["first wake", "second wake"]) {
    const { adapter, resumed } = recordingAdapter();
    const durable = openDurable(ctx.db);
    const runner = createRunner({ projects: [ctx.cfg], adapters: new Map([["codex", adapter]]), durable, env: ctx.env, startGapMs: 0, watch: false, pumpMs: 0 });
    await runner.boot();
    try {
      // The hook writes the registry again at each Stop; a stale seenAt would skip the wake.
      await recordSession({ ...ctx.cfg, peer: "codex", session: label }, { id: nativeId, cwd: ctx.root, harness: "codex", event: "stop" });
      const ev = fake.inject("ai-collab-demo--to--codex", direct(label, body));
      await runner.pump();
      await until(() => durable.status(`${WAKE}:codex#${label}:${ev.id}`)?.status === "SUCCESS", body);
      results.push(...resumed);
    } finally {
      await runner.stop();
    }
  }
  assert.deepEqual(results, [{ managed: true, env: "1" }, { managed: true, env: "1" }]);
});

// A record whose session workflow row is gone: managed cannot come from the durable input.
for (const [what, owned, registry] of [["owned record", true, false], ["registry entry", false, true]]) {
  test(`a wake with no session workflow row keeps the block when the ${what} says managed`, async (t) => {
    const fake = await startFakeNtfy();
    t.after(() => fake.close());
    const ctx = setup(t, fake);
    const nativeId = `codex-thread-orphan-${owned}`;
    const label = sessionLabel(nativeId);
    writeOwned({ ...ctx.cfg, peer: "codex", session: label }, {
      v: 1, label, address: `codex#${label}`, workflowId: `session:gone-${owned}`, harness: "codex", nativeId, project: "demo", cwd: ctx.root,
      place: "folder", permissionMode: "default", ...(owned ? { managed: true } : {}), status: "ended", run: null, approvals: [], createdAt: Date.now(),
    });
    await recordSession({ ...ctx.cfg, peer: "codex", session: label }, { id: nativeId, cwd: ctx.root, harness: "codex", event: "stop", managed: registry });
    const { adapter, resumed } = recordingAdapter();
    const durable = openDurable(ctx.db);
    const runner = createRunner({ projects: [ctx.cfg], adapters: new Map([["codex", adapter]]), durable, env: ctx.env, startGapMs: 0, watch: false, pumpMs: 0 });
    await runner.boot();
    try {
      const ev = fake.inject("ai-collab-demo--to--codex", direct(label, "resume"));
      await runner.pump();
      await until(() => durable.status(`${WAKE}:codex#${label}:${ev.id}`)?.status === "SUCCESS", "wake");
      assert.deepEqual(resumed, [{ managed: true, env: "1" }]);
    } finally {
      await runner.stop();
    }
  });
}
