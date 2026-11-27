// Characterizes the two push engines on the same scripted scenarios: the runner's durable workflow (runner/delivery.ts)
// and the UI dispatcher (web/server/dispatch.mjs). Both run on one clock; the expected pushes and close times are shared.
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { join } from "node:path";
import { mock, test, after } from "node:test";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { reserveDelivery, sendMessage } from "../lib/inbox.mjs";
import { busyWithPush, readDispatchLedger, readySession } from "../lib/deliver-push.ts";
import { processStart } from "../lib/process.ts";
import { writeState } from "../lib/state.ts";
import { openDurable } from "../runner/durable.mjs";
import { DELIVERY, deliveryWorkflow } from "../runner/delivery.ts";
import { MAX_ATTEMPTS, REDELIVER_MS, TTL_MS, createDispatcher } from "../web/server/dispatch.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const T0 = Date.UTC(2026, 10, 25);
const OPENCODE_ID = "ses_0123456789abcdefghijABCDEFGH";
const LABEL = sessionLabel(OPENCODE_ID);
const ADDRESS = `opencode#${LABEL}`;
const SESSION = { id: ADDRESS, harness: "opencode", sessionId: OPENCODE_ID, online: true, peer: "opencode", session: LABEL };
const CHUNK_MS = 5_000;

// Scenario script: busy is [from, to) in ms after T0; ackAt answers the message; restartAt restarts the engine;
// reservedElsewhere reserves the message before the first push; step is the driver's clock step (default CHUNK_MS).
// pushes lists each push as ms after T0; closedAt is when the message left the engine (absent = not checked).
const SCENARIOS = [
  { name: "first push goes out at once", expectReply: false, until: 60_000, pushes: [0], status: "delivered" },
  { name: "redelivery every 10 min, dropped after 5 attempts", expectReply: true, until: 3_005_000, pushes: [0, REDELIVER_MS, 2 * REDELIVER_MS, 3 * REDELIVER_MS, 4 * REDELIVER_MS], closedAt: 5 * REDELIVER_MS, status: "dropped" },
  { name: "busy target gets no redelivery until it is free", expectReply: true, busy: [599_000, 662_000], until: 720_000, pushes: [0, 665_000] },
  { name: "24 h TTL ends redelivery while the target stays busy", expectReply: true, busy: [1_000, Infinity], until: TTL_MS + 60_000, step: 60_000, pushes: [0], closedAt: TTL_MS, status: "expired" },
  { name: "answer before the redelivery ends it with no copy", expectReply: true, ackAt: 595_000, until: REDELIVER_MS + 10_000, pushes: [0], closedAt: { runner: REDELIVER_MS, dispatch: 595_000 }, status: "answered" },
  { name: "message reserved elsewhere is skipped", expectReply: false, reservedElsewhere: true, until: 10_000, pushes: [], status: "skipped" },
  { name: "restart keeps the redelivery schedule", expectReply: true, restartAt: 60_000, until: REDELIVER_MS + 5_000, pushes: [0, REDELIVER_MS] },
];

const flushed = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

// Runner engine: the durable workflow on mock timers, the same deps as runner/runner.mjs wires for an opencode session.
async function runnerEngine(s, state, pushes) {
  const dir = tempDir({ after }, "delivery-char-");
  const file = path.join(dir, "runner.db");
  mock.timers.reset();
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  const deps = {
    now: () => Date.now(),
    scfgOf: () => ({ project: "demo", peer: "opencode", session: LABEL }),
    sessionOf: () => SESSION,
    probe: async () => new Set(state.busy ? [OPENCODE_ID] : []),
    ready: async (session, active) => readySession(session, active),
    busy: async (session, active) => busyWithPush(session, active),
    reserve: async (scfg, ids) => ({ owned: state.reserved ? ids : [], busy: false }),
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
    acked: async () => state.acked,
    textFor: (scfg, m, attempt) => `${m.id} attempt ${attempt}`,
  };
  let durable;
  const open = () => {
    durable = openDurable(file, { now: () => Date.now() });
    durable.register(DELIVERY, deliveryWorkflow(deps));
  };
  open();
  const runId = `${DELIVERY}:${ADDRESS}:m1`;
  durable.startWorkflowOnce(DELIVERY, runId, { project: "demo", address: ADDRESS, message: { id: "m1", from: "operator", body: "hi", expectReply: s.expectReply } })?.catch(() => {});
  await flushed();
  return {
    async ack() {
      state.acked = true;
    },
    async advanceTo(_t, ms) {
      for (let left = ms; left > 0; left -= CHUNK_MS) {
        mock.timers.tick(Math.min(CHUNK_MS, left));
        await flushed();
      }
    },
    async restart() {
      await durable.close();
      open();
      durable.recover();
      await flushed();
    },
    observe() {
      const st = durable.status(runId);
      return st?.status === "SUCCESS" ? st.output.status : null;
    },
    async close() {
      await durable.close();
      mock.timers.reset();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Dispatcher engine: createDispatcher on the fake ntfy server, the same opencode session, and a clock it is ticked on.
async function dispatchEngine(s, state, pushes) {
  const fake = await startFakeNtfy();
  const env = peerEnv(fake, { peer: "operator", AI_COLLAB_PEERS: "alice,bob,opencode" });
  const cfg = loadConfig(env);
  const registry = join(cfg.stateDir, cfg.project, "registry");
  mkdirSync(registry, { recursive: true });
  writeState(join(registry, `${ADDRESS}.json`), {
    id: ADDRESS, sessionId: OPENCODE_ID, cwd: "/tmp", harness: "opencode", event: "Stop", seenAt: Date.now(), pid: process.pid, pidStart: processStart(process.pid),
  });
  const bob = loadConfig(peerEnv(fake, { peer: "bob", AI_COLLAB_PEERS: env.AI_COLLAB_PEERS, AI_COLLAB_STATE_DIR: cfg.stateDir }));
  const opencodeAs = loadConfig(peerEnv(fake, { peer: "opencode", AI_COLLAB_PEERS: "alice,bob,opencode", AI_COLLAB_STATE_DIR: cfg.stateDir }), { session: LABEL });
  const clock = { t: T0 };
  const opencode = async (method, _path, options) => {
    if (method === "POST") {
      pushes.push(clock.t - T0);
      return { ok: true, status: 200, body: {} };
    }
    return { ok: true, status: 200, body: { data: state.busy ? { [OPENCODE_ID]: {} } : {} } };
  };
  const make = () => createDispatcher({ projects: () => [cfg], now: () => clock.t, env: { HOME: cfg.stateDir }, opencode, idle: async () => "idle", run: async () => 0 });
  let dispatcher = make();
  let sent = null;
  let seen = false;
  return {
    async begin() {
      sent = await sendMessage(bob, ADDRESS, "need an answer", { expectReply: s.expectReply });
      if (s.reservedElsewhere) await reserveDelivery({ ...cfg, peer: "opencode", session: LABEL }, [sent.id]);
    },
    async ack() {
      await sendMessage(opencodeAs, "bob", "on it", { replyTo: sent.id, state: "working" });
    },
    async advanceTo(t) {
      clock.t = T0 + t;
      await dispatcher.tick();
    },
    async restart() {
      dispatcher = make();
    },
    observe() {
      const has = Boolean(readDispatchLedger(cfg)[sent.id]);
      if (has) seen = true;
      return seen && !has ? "gone" : null;
    },
    async close() {
      await fake.close();
    },
  };
}

// Drives one engine through the scenario on the shared clock and reports its pushes and close time.
async function drive(s, make) {
  const state = { busy: false, acked: false, reserved: !s.reservedElsewhere };
  const pushes = [];
  const engine = await make(s, state, pushes);
  let closedAt = null;
  let status = null;
  try {
    if (engine.begin) await engine.begin();
    const stepMs = s.step ?? CHUNK_MS;
    let prev = 0;
    for (let t = 0; t <= s.until; t += stepMs) {
      state.busy = Boolean(s.busy) && t >= s.busy[0] && t < s.busy[1];
      if (t === s.ackAt) await engine.ack();
      if (t === s.restartAt) await engine.restart();
      await engine.advanceTo(t, t - prev);
      prev = t;
      const observed = engine.observe();
      if (observed !== null && closedAt === null) {
        closedAt = t;
        status = observed === "gone" ? null : observed;
      }
    }
  } finally {
    await engine.close();
  }
  return { pushes, closedAt, status };
}

for (const s of SCENARIOS) {
  for (const [kind, make] of [["runner", runnerEngine], ["dispatch", dispatchEngine]]) {
    test(`${s.name} (${kind})`, async () => {
      const got = await drive(s, make);
      assert.deepEqual(got.pushes, s.pushes);
      // The runner checks acks only at its redelivery wake; the dispatcher checks them on every tick.
      if ("closedAt" in s) assert.equal(got.closedAt, typeof s.closedAt === "object" ? s.closedAt[kind] : s.closedAt);
      if (kind === "runner" && "status" in s) assert.equal(got.status, s.status);
    });
  }
}

test("the engines share one attempt limit and redelivery gap", () => {
  assert.deepEqual([MAX_ATTEMPTS, REDELIVER_MS, TTL_MS], [5, 10 * 60_000, 24 * 3_600_000]);
});
