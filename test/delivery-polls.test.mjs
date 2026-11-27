// Live-probe discipline of the two push engines: no ack or readiness polls where the policy cannot use them, replay without
// probes, and the dispatcher's TTL for messages whose pushes keep failing.
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { join } from "node:path";
import { mock, test } from "node:test";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig, sessionLabel } from "../lib/config.ts";
import { sendMessage } from "../lib/messaging.ts";
import { processStart } from "../lib/process.ts";
import { writeState } from "../lib/state.ts";
import { openDurable } from "../lib/durable.ts";
import { DELIVERY, deliveryWorkflow } from "../runner/delivery.ts";
import { REDELIVER_MS, TTL_MS, createDispatcher } from "../web/server/dispatch.ts";
import { tempDir } from "./helpers/tmp.mjs";

const T0 = Date.UTC(2026, 10, 25);
const CODEX_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const LABEL = sessionLabel(CODEX_ID);
const ADDRESS = `codex#${LABEL}`;
const SESSION = { id: ADDRESS, harness: "codex", sessionId: CODEX_ID, online: true, peer: "codex", session: LABEL };
const SCFG = { project: "demo", peer: "codex", session: LABEL };

const flushed = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

// Deps for one runner workflow: live readiness and busy state come from state; acked calls are counted.
function runnerDeps(state, pushes) {
  return {
    now: () => Date.now(),
    scfgOf: () => SCFG,
    sessionOf: () => SESSION,
    probe: async () => null,
    ready: async () => state.ready,
    busy: async () => {
      state.busyCalls += 1;
      return state.busy;
    },
    reserve: async (scfg, ids) => ({ owned: ids, busy: false }),
    release: async () => {},
    markDelivered: async () => {},
    snapshot: async () => null,
    push: async () => {
      pushes.push(Date.now() - T0);
      return { status: "delivered" };
    },
    awaitConfirm: async () => true,
    confirmedSince: async () => false,
    waitConfirmed: async () => false,
    acked: async () => {
      state.ackedCalls += 1;
      return false;
    },
    textFor: (scfg, m, attempt) => `${m.id} attempt ${attempt}`,
    redeliverMs: 60_000,
    readyPollMs: 5_000,
  };
}

const newState = () => ({ ready: false, busy: false, ackedCalls: 0, busyCalls: 0 });

test("a runner message waiting for its first push polls no acks", async (t) => {
  const dir = tempDir(t, "delivery-polls-");
  const state = newState();
  const pushes = [];
  const durable = openDurable(path.join(dir, "runner.db"));
  durable.register(DELIVERY, deliveryWorkflow({ ...runnerDeps(state, pushes), readyPollMs: 5 }));
  try {
    const run = durable.startWorkflowOnce(DELIVERY, `${DELIVERY}:${ADDRESS}:m1`, { project: "demo", address: ADDRESS, message: { id: "m1", from: "operator", body: "hi" } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    state.ready = true;
    assert.deepEqual(await run, { status: "delivered", pushes: 1 });
    assert.equal(state.ackedCalls, 0, "acks polled while the target was offline and before the first push");
  } finally {
    await durable.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a restart replays recorded redelivery steps without probing a busy target", async (t) => {
  const dir = tempDir(t, "delivery-replay-");
  const file = path.join(dir, "runner.db");
  const state = newState();
  const pushes = [];
  const message = { id: "m1", from: "operator", body: "hi", expectReply: true };
  const runId = `${DELIVERY}:${ADDRESS}:m1`;
  mock.timers.reset();
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  try {
    let durable = openDurable(file, { now: () => Date.now() });
    durable.register(DELIVERY, deliveryWorkflow(runnerDeps(state, pushes)));
    state.ready = true;
    durable.startWorkflowOnce(DELIVERY, runId, { project: "demo", address: ADDRESS, message })?.catch(() => {});
    await flushed();
    mock.timers.tick(60_000);
    await flushed();
    assert.deepEqual(pushes, [0, 60_000], "attempt 2 went out at the first redelivery");
    await durable.close();

    // The target is busy now; the recorded attempt 2 must replay without waiting for it.
    state.busy = true;
    state.busyCalls = 0;
    durable = openDurable(file, { now: () => Date.now() });
    durable.register(DELIVERY, deliveryWorkflow(runnerDeps(state, pushes)));
    durable.recover();
    await flushed();
    assert.equal(state.busyCalls, 0, "replay probed the busy target");
    assert.deepEqual(pushes, [0, 60_000], "replay pushed again");
    await durable.close();
  } finally {
    mock.timers.reset();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Dispatcher harness: a codex session on the fake ntfy server, with the clock and the codex runner under the test's control.
async function dispatchSetup(t, { run = async () => 0, idleCalls = { n: 0 } } = {}) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "operator", AI_COLLAB_PEERS: "alice,bob,codex" });
  const cfg = loadConfig(env);
  const registry = join(cfg.stateDir, cfg.project, "registry");
  mkdirSync(registry, { recursive: true });
  writeState(join(registry, `${ADDRESS}.json`), {
    id: ADDRESS, sessionId: CODEX_ID, cwd: "/tmp", harness: "codex", event: "Stop", seenAt: Date.now(), pid: process.pid, pidStart: processStart(process.pid),
  });
  const bob = loadConfig(peerEnv(fake, { peer: "bob", AI_COLLAB_PEERS: env.AI_COLLAB_PEERS, AI_COLLAB_STATE_DIR: cfg.stateDir }));
  const clock = { t: T0 };
  const dispatcher = createDispatcher({
    projects: () => [cfg],
    now: () => clock.t,
    env: { HOME: cfg.stateDir },
    run: async (file, args) => run(file, args, clock.t),
    opencode: async () => ({ ok: true, status: 200, body: {} }),
    idle: async () => {
      idleCalls.n += 1;
      return "idle";
    },
  });
  return { bob, address: ADDRESS, clock, dispatcher };
}

test("a dispatched message not yet due probes no readiness", async (t) => {
  const idleCalls = { n: 0 };
  const { bob, address, clock, dispatcher } = await dispatchSetup(t, { idleCalls });
  await sendMessage(bob, address, "need an answer", { expectReply: true });
  assert.equal((await dispatcher.tick()).delivered, 1);
  clock.t += 60_000;
  idleCalls.n = 0;
  await dispatcher.tick();
  // One call: the first-push gate for the session. The redelivery decision must not probe while it is not due.
  assert.equal(idleCalls.n, 1);
});

test("a dispatched message whose pushes keep failing stops at the TTL", async (t) => {
  const attempts = [];
  const { bob, address, clock, dispatcher } = await dispatchSetup(t, {
    run: async (file, args, at) => {
      attempts.push(at - T0);
      return 1;
    },
  });
  await sendMessage(bob, address, "never lands", { expectReply: true });
  for (let t = 0; t <= TTL_MS + REDELIVER_MS; t += 300_000) {
    clock.t = T0 + t;
    await dispatcher.tick();
  }
  assert.ok(attempts.length > 1, "the failing push was retried");
  assert.ok(Math.max(...attempts) < TTL_MS, `a push went out at ${Math.max(...attempts)} ms, after the TTL`);
});
