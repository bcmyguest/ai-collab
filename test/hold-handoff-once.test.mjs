// A message a push hands to a Stop hook hold counts as delivered: no later push or waiter shows it again.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { claimInbox, markDelivered, readInbox, releaseOwned, reserveOwned, sendMessage } from "../lib/messaging.ts";
import { holdRunning, readDispatchLedger } from "../lib/deliver-push.mjs";
import { decideStop, handOff, markStopRunning } from "../lib/stop.mjs";
import { requestWait } from "../lib/questions.mjs";
import { processStart } from "../lib/process.mjs";
import { statePath, writeState } from "../lib/state.mjs";
import { runWaiter } from "../lib/waiter.ts";
import { openDurable } from "../runner/durable.mjs";
import { deliveryWorkflow } from "../runner/delivery.mjs";
import { createDispatcher } from "../web/server/dispatch.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const CLAUDE_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5e";
const LABEL = sessionLabel(CLAUDE_ID);
const ADDRESS = `claude#${LABEL}`;
const ALL = "ai-collab-demo--to--all";
const SESSION = { id: ADDRESS, harness: "claude", sessionId: CLAUDE_ID, online: true, peer: "claude", session: LABEL };
const HOLD = { host: "claude", input: { stop_hook_active: false }, sliceMaxS: 10, queued: null };

// A registered Claude session with a listening fake socket, AFK on and a wait requested, so its Stop hook holds.
async function setup(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "operator", AI_COLLAB_PEERS: "bob,claude", AI_COLLAB_AFK_WAIT_S: "30", AI_COLLAB_ACTIVITY: "off" });
  const cfg = loadConfig(env);
  const registry = join(cfg.stateDir, cfg.project, "registry");
  mkdirSync(registry, { recursive: true });
  const claudeDir = join(cfg.stateDir, ".claude");
  mkdirSync(join(claudeDir, "sessions"), { recursive: true });
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ crossSessionInbound: "accept" }));
  writeState(join(registry, `${ADDRESS}.json`), {
    id: ADDRESS, sessionId: CLAUDE_ID, cwd: "/tmp", harness: "claude", event: "Stop", seenAt: Date.now(), pid: process.pid, pidStart: processStart(process.pid),
  });
  const frames = [];
  const socketPath = join(tempDir({ after }, "hho-sock-"), "s.sock");
  const server = createServer((conn) => conn.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) frames.push(JSON.parse(line));
  }));
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  writeFileSync(join(claudeDir, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: CLAUDE_ID, status: "idle", cwd: "/tmp", messagingSocketPath: socketPath }));
  writeFileSync(join(claudeDir, "sessions", `${process.pid}.k1.key`), "peer-token\n");
  const bob = loadConfig(peerEnv(fake, { peer: "bob", AI_COLLAB_PEERS: env.AI_COLLAB_PEERS, AI_COLLAB_STATE_DIR: cfg.stateDir }));
  const target = loadConfig({ ...env, AI_COLLAB_PEER: "claude" }, { session: LABEL });
  fake.inject(ALL, JSON.stringify({ v: 1, kind: "mode", from: "operator", mode: "on", ts: Date.now() }));
  await claimInbox(target);
  await requestWait(target);
  return { cfg, bob, target, frames, env: { HOME: cfg.stateDir } };
}

// How many times the formatted text shows a message body.
const shown = (text, body) => text.split(`body="${body}"`).length - 1;

const handoffExists = (cfg) => existsSync(statePath(cfg).replace(/\.json$/, ".handoff.json"));

// The runner's delivery workflow on the live inbox functions; push records instead of writing to a socket.
function runnerWorkflow(t, target, pushes, overrides = {}) {
  const dir = tempDir({ after }, "hho-db-");
  const durable = openDurable(join(dir, "runner.db"));
  t.after(async () => { await durable.close(); rmSync(dir, { recursive: true, force: true }); });
  durable.register("delivery", deliveryWorkflow({
    now: () => Date.now(),
    scfgOf: () => target,
    sessionOf: () => SESSION,
    ready: async () => true,
    held: async (session, scfg) => holdRunning(session, scfg),
    handOff: (scfg, messages) => handOff(scfg, messages),
    reserve: (scfg, ids, { owner, allowSeen }) => reserveOwned(scfg, ids, { owner, allowSeen }),
    release: (scfg, ids, owner) => releaseOwned(scfg, ids, owner),
    markDelivered: (scfg, ids) => markDelivered(scfg, ids),
    snapshot: async () => null,
    push: async () => { pushes.push(Date.now()); return { status: "delivered" }; },
    awaitConfirm: async () => true,
    confirmedSince: async () => false,
    waitConfirmed: async () => false,
    acked: async () => false,
    textFor: (scfg, m) => m.body,
    backoffMs: () => 50,
    readyPollMs: 50,
    ...overrides,
  }));
  return durable;
}

test("an expect-reply redelivery handed to a hold is not pushed again when the hold ends", { timeout: 30000 }, async (t) => {
  const { bob, target } = await setup(t);
  await sendMessage(bob, ADDRESS, "answer me", { expectReply: true });
  const [message] = await readInbox(target, { peek: true, strict: false });
  await markDelivered(target, [message.id]);
  const pushes = [];
  const durable = runnerWorkflow(t, target, pushes, { redeliverMs: 4000 });
  // The first push went out earlier; the redelivery is due in 4 s, while the hold runs.
  durable.startWorkflowOnce("delivery", `delivery:${ADDRESS}:${message.id}`, { project: target.project, address: ADDRESS, message, redeliver: { pushes: 1, firstAt: Date.now() } })?.catch(() => {});
  await delay(3500);
  const r = await decideStop(target, HOLD);
  const heldUntil = Date.now();
  assert.equal(r.why, "messages");
  assert.equal(shown(r.text, "answer me"), 1, "the hold shows the redelivery");
  await delay(1500);
  assert.deepEqual(pushes.filter((at) => at >= heldUntil - 100), [], "the runner pushed the message again right after the hold");
});

test("the runner does not push a message it handed to a hold that ended before reading it, and the next waiter shows it once", { timeout: 20000 }, async (t) => {
  const { bob, target } = await setup(t);
  await sendMessage(bob, ADDRESS, "hold killed");
  const [message] = await readInbox(target, { peek: true, strict: false });
  const pushes = [];
  const release = markStopRunning(target);
  const durable = runnerWorkflow(t, target, pushes);
  const out = await durable.startWorkflowOnce("delivery", `delivery:${ADDRESS}:${message.id}`, { project: target.project, address: ADDRESS, message });
  // The hold is killed before its first one-second poll of the hand-off file.
  release();
  assert.equal(out.status, "delivered");
  await delay(300);
  assert.deepEqual(pushes, [], "the runner pushed a handed message");
  const r = await runWaiter(target, { maxMs: 3000 });
  assert.equal(r.code, 2);
  assert.equal(shown(r.text, "hold killed"), 1);
  assert.equal((await claimInbox(target)).length, 0, "no later inbox read shows it");
});

test("the dispatcher counts a message handed to a hold as delivered and does not push it after the hold ends", { timeout: 20000 }, async (t) => {
  const { cfg, bob, target, frames, env } = await setup(t);
  let release = null;
  // The Stop hook marks itself between the dispatcher's ready check and its push.
  const claim = (scfg, opts) => {
    release ??= markStopRunning(target);
    return claimInbox(scfg, opts);
  };
  const dispatcher = createDispatcher({ projects: () => [cfg], env, claim, opencode: async () => ({ ok: true, status: 200, body: {} }), run: async () => 1 });
  const sent = await sendMessage(bob, ADDRESS, "dispatcher hand-off", { expectReply: true });
  assert.equal((await dispatcher.tick()).delivered, 1, "the hand-off counts as a delivery");
  assert.equal(readDispatchLedger(cfg)[sent.id]?.attempts, 1, "the expect-reply ledger entry is written");
  // The hold is killed before it reads the hand-off.
  release();
  await dispatcher.tick();
  assert.equal(frames.length, 0, "the dispatcher pushed a handed message");
  const r = await runWaiter(target, { maxMs: 3000 });
  assert.equal(r.code, 2);
  assert.equal(shown(r.text, "dispatcher hand-off"), 1);
});

test("a push that hands off between the hold's take and its inbox read is shown once, and not again by the next waiter", { timeout: 20000 }, async (t) => {
  const { cfg, bob, target, env } = await setup(t);
  let holdReading;
  const reading = new Promise((resolve) => { holdReading = resolve; });
  let pushed;
  const pushDone = new Promise((resolve) => { pushed = resolve; });
  let hold = null;
  // The hold's first inbox read waits until the push has handed off: its hand-off take ran before the push.
  const holdClaim = async (scfg, opts) => {
    holdReading();
    await pushDone;
    return claimInbox(scfg, opts);
  };
  const claim = async (scfg, opts) => {
    if (!hold) {
      hold = decideStop(target, { ...HOLD, claim: holdClaim });
      await reading;
    }
    return claimInbox(scfg, opts);
  };
  const dispatcher = createDispatcher({ projects: () => [cfg], env, claim, opencode: async () => ({ ok: true, status: 200, body: {} }), run: async () => 1 });
  await sendMessage(bob, ADDRESS, "between take and read");
  await dispatcher.tick();
  pushed();
  const r = await hold;
  assert.equal(r.why, "messages");
  assert.equal(shown(r.text, "between take and read"), 1);
  assert.equal(handoffExists(target), false, "the hold took the hand-off");
  const next = await runWaiter(target, { maxMs: 2500 });
  assert.equal(next.code, 0, "the next waiter showed the message again");
});
