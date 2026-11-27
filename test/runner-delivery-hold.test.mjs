// The runner's delivery workflow leaves a message for a Claude session's Stop hook hold: no push while the hold runs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { handedOff, markStopRunning } from "../lib/stop.mjs";
import { processStart } from "../lib/process.mjs";
import { writeState } from "../lib/state.mjs";
import { openDurable } from "../runner/durable.mjs";
import { deliveryWorkflow } from "../runner/delivery.mjs";
import { createRunner } from "../runner/runner.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const CLAUDE_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const LABEL = sessionLabel(CLAUDE_ID);
const ADDRESS = `claude#${LABEL}`;
const SESSION = { id: ADDRESS, harness: "claude", sessionId: CLAUDE_ID, online: true, peer: "claude", session: LABEL };
const message = { id: "m1", from: "operator", body: "hi" };

// Workflow deps that record pushes and releases; overrides replace any of them.
function deps(log, overrides = {}) {
  return {
    now: () => Date.now(),
    scfgOf: () => ({ project: "demo", peer: "claude", session: LABEL }),
    sessionOf: () => SESSION,
    ready: async () => true,
    reserve: async (scfg, ids) => ({ owned: ids, busy: false }),
    release: async (scfg, ids, owner) => { log.releases.push(owner); },
    markDelivered: async () => {},
    snapshot: async () => null,
    push: async () => { log.pushes.push(Date.now()); return { status: "delivered" }; },
    awaitConfirm: async () => true,
    confirmedSince: async () => false,
    waitConfirmed: async () => false,
    acked: async () => false,
    textFor: (scfg, m, attempt) => `${m.id} attempt ${attempt}`,
    backoffMs: () => 5,
    readyPollMs: 5,
    ...overrides,
  };
}

function durableIn(t) {
  const dir = tempDir({ after }, "ai-collab-hold-");
  const durable = openDurable(join(dir, "runner.db"));
  t.after(async () => { await durable.close(); rmSync(dir, { recursive: true, force: true }); });
  return durable;
}

// A registered Claude session whose record under HOME/.claude points at a listening fake socket.
async function claudeSession(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "runner", AI_COLLAB_PEERS: "claude,runner" });
  const cfg = loadConfig(env);
  const registry = join(cfg.stateDir, cfg.project, "registry");
  mkdirSync(registry, { recursive: true });
  const claudeDir = join(cfg.stateDir, ".claude");
  mkdirSync(join(claudeDir, "sessions"), { recursive: true });
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ crossSessionInbound: "accept" }));
  writeState(join(registry, `${ADDRESS}.json`), {
    id: ADDRESS, sessionId: CLAUDE_ID, cwd: "/tmp", harness: "claude", event: "Stop", seenAt: Date.now(), pid: process.pid, pidStart: processStart(process.pid),
  });
  const socketPath = join(tempDir({ after }, "rdh-sock-"), "s.sock");
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  writeFileSync(join(claudeDir, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: CLAUDE_ID, status: "idle", cwd: "/tmp", messagingSocketPath: socketPath }));
  writeFileSync(join(claudeDir, "sessions", `${process.pid}.k1.key`), "peer-token\n");
  const target = loadConfig({ ...env, AI_COLLAB_PEER: "claude" }, { session: LABEL });
  return { cfg, target, env: { ...env, HOME: cfg.stateDir } };
}

// The live runner deliveryDeps with only the push and the given deps replaced; resolves the workflow output.
function runnerDelivery(t, ctx, log, delivery) {
  const durable = durableIn(t);
  createRunner({ projects: [ctx.cfg], adapters: new Map(), durable, env: ctx.env, watch: false, pumpMs: 0, delivery: {
    push: async () => { log.pushes.push(Date.now()); return { status: "delivered" }; },
    readyPollMs: 20,
    backoffMs: () => 20,
    ...delivery,
  } });
  return durable.startWorkflowOnce("delivery", `delivery:${ADDRESS}:m1`, { project: ctx.cfg.project, address: ADDRESS, message });
}

test("the delivery workflow passes the project to ready", async (t) => {
  const log = { pushes: [], releases: [] };
  const projects = [];
  const durable = durableIn(t);
  durable.register("delivery", deliveryWorkflow(deps(log, { ready: async (session, active, project) => { projects.push(project); return true; } })));
  const out = await durable.startWorkflowOnce("delivery", "delivery:a:m1", { project: "demo", address: ADDRESS, message });
  assert.equal(out.status, "delivered");
  assert.ok(projects.length > 0);
  assert.deepEqual([...new Set(projects)], ["demo"]);
});

test("a hold that starts after the ready check releases the reservation and the push waits until it ends", async (t) => {
  const log = { pushes: [], releases: [] };
  let checks = 0;
  const durable = durableIn(t);
  durable.register("delivery", deliveryWorkflow(deps(log, { held: async () => (checks += 1) === 1 })));
  const out = await durable.startWorkflowOnce("delivery", "delivery:a:m1", { project: "demo", address: ADDRESS, message });
  assert.equal(out.status, "delivered");
  assert.equal(log.pushes.length, 1);
  assert.equal(checks, 2, "the push waited for a hold check that found the hold ended");
  assert.ok(log.releases.length > 0 && log.releases.every((owner) => owner === "delivery:a:m1"), "the reservation was released for the hold");
});

test("the runner's ready check sees the target's Stop hook through the project config", async (t) => {
  const ctx = await claudeSession(t);
  const log = { pushes: [] };
  const release = markStopRunning(ctx.target);
  const out = runnerDelivery(t, ctx, log, { held: async () => false });
  await delay(400);
  assert.equal(log.pushes.length, 0, "pushed while the Stop hook ran");
  release();
  assert.equal((await out).status, "delivered");
  assert.equal(log.pushes.length, 1);
});

test("the runner re-checks the target's Stop hook right before the push", async (t) => {
  const ctx = await claudeSession(t);
  const log = { pushes: [] };
  const release = markStopRunning(ctx.target);
  const out = runnerDelivery(t, ctx, log, { ready: async () => true });
  await delay(400);
  assert.equal(log.pushes.length, 0, "pushed while the Stop hook ran");
  release();
  assert.equal((await out).status, "delivered", "the hand-off to the hold counts as delivered");
  assert.equal(log.pushes.length, 0, "the hold gets the message through the hand-off, not a push");
  assert.equal(handedOff(ctx.target, "m1"), true, "the hand-off file holds the message");
});
