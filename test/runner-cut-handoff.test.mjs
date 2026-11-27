import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDurable } from "../runner/durable.mjs";
import { deliveryWorkflow } from "../runner/delivery.mjs";
import { handedOff, handOff } from "../lib/stop.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION = { id: "claude#abc", harness: "claude", sessionId: "t1", online: true, peer: "claude", session: "abc" };
const MESSAGE = { id: "m1", from: "operator", body: "hi" };
const INPUT = { project: "demo", address: SESSION.id, message: MESSAGE };

// A first runner that is killed right after its hand-off, before the push step records a result.
const CHILD = `
const at = (p) => new URL(p, process.env.ROOT_URL).href;
const { openDurable } = await import(at("runner/durable.mjs"));
const { deliveryWorkflow } = await import(at("runner/delivery.mjs"));
const { handOff } = await import(at("lib/stop.mjs"));
const scfg = JSON.parse(process.env.SCFG);
const session = JSON.parse(process.env.SESSION);
const durable = openDurable(process.env.DB);
durable.register("delivery", deliveryWorkflow({
  now: () => Date.now(), scfgOf: () => scfg, sessionOf: () => session, ready: async () => true,
  reserve: async (c, ids) => ({ owned: ids, busy: false }), release: async () => {}, markDelivered: async () => {},
  snapshot: async () => null, push: async () => ({ status: "delivered" }), held: async () => true,
  handOff: async (c, messages) => { await handOff(c, messages); process.kill(process.pid, "SIGKILL"); },
  awaitConfirm: async () => true, confirmedSince: async () => false, waitConfirmed: async () => false, acked: async () => false,
  textFor: (c, m, attempt) => m.id + " attempt " + attempt, backoffMs: () => 5, redeliverMs: 20, readyPollMs: 5,
}));
durable.startWorkflow("delivery", "delivery:x", JSON.parse(process.env.INPUT));
setTimeout(() => {}, 20000);
`;

// Deps for the recovered runner; it records every push, mark and release into log.
function depsWith(log, scfg) {
  return {
    now: () => Date.now(),
    scfgOf: () => scfg,
    sessionOf: () => SESSION,
    ready: async () => true,
    reserve: async (c, ids) => ({ owned: ids, busy: false }),
    release: async () => { log.releases += 1; },
    markDelivered: async () => { log.marks += 1; },
    snapshot: async () => null,
    push: async () => { log.pushes += 1; return { status: "delivered" }; },
    held: async () => true,
    handOff: async (c, messages) => { log.handOffs += 1; await handOff(c, messages); },
    handedOff: (c, id) => handedOff(c, id),
    awaitConfirm: async () => true,
    confirmedSince: async () => false,
    waitConfirmed: async () => false,
    acked: async () => false,
    textFor: (c, m, attempt) => `${m.id} attempt ${attempt}`,
    backoffMs: () => 5,
    redeliverMs: 20,
    readyPollMs: 5,
  };
}

test("a runner killed after the hand-off but before the push checkpoint marks the message instead of releasing it", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai-collab-cut-handoff-"));
  const scfg = { stateDir: dir, project: "demo", peer: "claude", session: "abc" };
  mkdirSync(path.join(dir, "demo", "sessions", "claude"), { recursive: true });
  const file = path.join(dir, "runner.db");
  const env = { ...process.env, ROOT_URL: pathToFileURL(`${ROOT}/`).href, DB: file, SCFG: JSON.stringify(scfg), SESSION: JSON.stringify(SESSION), INPUT: JSON.stringify(INPUT) };
  const first = spawnSync(process.execPath, ["--input-type=module", "-e", CHILD], { encoding: "utf8", timeout: 30_000, env });
  assert.equal(first.signal, "SIGKILL", first.stderr);
  assert.equal(handedOff(scfg, "m1"), true);

  const log = { pushes: 0, marks: 0, releases: 0, handOffs: 0 };
  const second = openDurable(file);
  second.register("delivery", deliveryWorkflow(depsWith(log, scfg)));
  second.recover();
  assert.equal((await second.result("delivery:x")).status, "delivered");
  assert.deepEqual(log, { pushes: 0, marks: 1, releases: 0, handOffs: 0 });
  await second.close();
});
