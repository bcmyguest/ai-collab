import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { claimInbox } from "../lib/inbox.mjs";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { recordSession } from "../lib/sessions.mjs";
import { openDurable } from "../runner/durable.mjs";
import { createRunner, WAKE } from "../runner/runner.mjs";
import { createFakeAdapter } from "../runner/adapters/fake.mjs";

// A throwaway HOME with a project, a state dir and a durable log on the fake ntfy.
function setup(fake) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-wake-"));
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
  assert.equal(cfg.enabled, true, cfg.reason);
  return { root, env, cfg, db: path.join(home, "state", "runner.db") };
}

function makeRunner(ctx, adapters, { watch = true } = {}) {
  const durable = openDurable(ctx.db);
  return { durable, runner: createRunner({ projects: [ctx.cfg], adapters: new Map(adapters.map((a) => [a.harness, a])), durable, env: ctx.env, startGapMs: 0, watch, pumpMs: 0 }) };
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

const direct = (label, body) => JSON.stringify({ v: 1, kind: "msg", from: "operator", to: "codex", toSession: label, operatorThread: true, ts: new Date().toISOString(), body });

test("a direct message to a closed owned session wakes it for one run and closes it again; a broadcast does not", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const adapter = createFakeAdapter({ harness: "codex" });
  const { runner, durable } = makeRunner(ctx, [adapter]);
  await runner.boot();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const { session, nativeId } = await runner.start({ project: "demo", harness: "codex", prompt: "first" });
    await until(() => runner.get(session).status === "idle", "idle");
    await runner.close(session);
    await until(() => runner.get(session).status === "ended", "ended");

    fake.inject("ai-collab-demo--to--all", JSON.stringify({ v: 1, kind: "msg", from: "operator", to: "all", ts: new Date().toISOString(), body: "hello all" }));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(adapter.calls.filter((c) => c.op === "resume").length, 0, "a broadcast must not wake a closed session");

    const ev = fake.inject("ai-collab-demo--to--codex", direct(sessionLabel(nativeId), "wake up please"));
    const wakeId = `${WAKE}:${session}:${ev.id}`;
    await until(() => durable.status(wakeId)?.status === "SUCCESS", "wake");
    assert.deepEqual(durable.status(wakeId).output, { ended: "closed again after a message" });
    const resume = adapter.calls.find((c) => c.op === "resume");
    assert.equal(resume.nativeId, nativeId);
    const sends = adapter.calls.filter((c) => c.op === "send");
    assert.equal(sends.length, 2);
    assert.match(sends[1].text, /wake up please/);
    assert.equal(runner.get(session).status, "ended");
  } finally {
    await runner.stop();
    await fake.close();
  }
});

test("a direct message to a closed session that is not owned adopts it and wakes it through the adapter", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const adapter = createFakeAdapter({ harness: "codex" });
  const { runner, durable } = makeRunner(ctx, [adapter], { watch: false });
  await runner.boot();
  try {
    const nativeId = "codex-thread-adopt-1";
    const label = sessionLabel(nativeId);
    await recordSession({ ...ctx.cfg, peer: "codex", session: label }, { id: nativeId, cwd: ctx.root, harness: "codex", event: "stop", model: "gpt-test" });

    const ev = fake.inject("ai-collab-demo--to--codex", direct(label, "adopt and answer"));
    const started = await runner.pump();
    const wakeId = `${WAKE}:codex#${label}:${ev.id}`;
    assert.ok(started.includes(wakeId), `pump started ${started.join(", ")}`);
    await until(() => durable.status(wakeId)?.status === "SUCCESS", "adopted wake");

    const resume = adapter.calls.find((c) => c.op === "resume");
    assert.equal(resume.nativeId, nativeId);
    assert.match(adapter.calls.find((c) => c.op === "send" && /adopt and answer/.test(c.text)).text, /adopt and answer/);
    assert.equal(runner.get(`codex#${label}`).status, "ended");
    assert.equal(runner.get(`codex#${label}`).nativeId, nativeId);
    // The message is delivered: the next pump starts nothing for it.
    assert.deepEqual(await runner.pump(), []);
  } finally {
    await runner.stop();
    await fake.close();
  }
});

test("a closed claude session with no loaded adapter records that and leaves its message for the hooks", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const adapter = createFakeAdapter({ harness: "codex" });
  const { runner, durable } = makeRunner(ctx, [adapter], { watch: false });
  await runner.boot();
  try {
    const nativeId = "claude-chat-1";
    const label = sessionLabel(nativeId);
    await recordSession({ ...ctx.cfg, peer: "claude", session: label }, { id: nativeId, cwd: ctx.root, harness: "claude", event: "stop" });
    const ev = fake.inject("ai-collab-demo--to--claude", JSON.stringify({ v: 1, kind: "msg", from: "operator", to: "claude", toSession: label, operatorThread: true, ts: new Date().toISOString(), body: "for claude" }));
    const wakeId = `${WAKE}:claude#${label}:${ev.id}`;
    await runner.pump();
    await until(() => durable.status(wakeId)?.status === "SUCCESS", "no-adapter wake");
    assert.deepEqual(durable.status(wakeId).output, { status: "no-adapter", error: "no claude adapter yet" });
    assert.equal(adapter.calls.length, 0);
    const left = await claimInbox({ ...ctx.cfg, peer: "claude", session: label }, { commit: false, accept: () => true });
    assert.ok(left.some((m) => m.id === ev.id), "the hooks can still take the message");
  } finally {
    await runner.stop();
    await fake.close();
  }
});
