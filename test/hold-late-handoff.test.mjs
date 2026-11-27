// A push that finds a Stop hook hold hands the message to it through the hand-off file, and it is delivered once.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig, sessionLabel } from "../lib/config.ts";
import { claimInbox, markDelivered, readInbox, releaseDelivery, releaseOwned, reserveDelivery, reserveOwned, sendMessage } from "../lib/messaging.ts";
import { holdRunning } from "../lib/deliver-push.ts";
import { decideStop, handOff, markStopRunning } from "../lib/stop.ts";
import { requestWait } from "../lib/questions.ts";
import { processStart } from "../lib/process.ts";
import { statePath, writeState } from "../lib/state.ts";
import { runWaiter } from "../lib/waiter.ts";
import { openDurable } from "../runner/durable.mjs";
import { deliveryWorkflow } from "../runner/delivery.ts";
import { createDispatcher } from "../web/server/dispatch.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const CLAUDE_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d";
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
  const socketPath = join(tempDir({ after }, "hlh-sock-"), "s.sock");
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

function handoffMessages(cfg) {
  try { return JSON.parse(readFileSync(statePath(cfg).replace(/\.json$/, ".handoff.json"), "utf8")).messages; } catch { return null; }
}

// How many times the formatted text shows a message body.
const shown = (text, body) => text.split(`body="${body}"`).length - 1;

test("a reserved message reaches a hold with a 10 s slice within 2 s when the push finds the hold 1 s in", { timeout: 20000 }, async (t) => {
  const { bob, target } = await setup(t);
  await sendMessage(bob, ADDRESS, "late for the hold");
  const [message] = await readInbox(target, { peek: true, strict: false });
  let hold = null;
  let holdAt = 0;
  const pushes = [];
  const dir = tempDir({ after }, "hlh-db-");
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
    // The hold starts once the message is reserved, and the push comes 1 s later.
    textFor: async (scfg, m) => {
      if (!hold) {
        holdAt = Date.now();
        hold = decideStop(target, HOLD).then((r) => ({ ...r, at: Date.now() }));
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      return m.body;
    },
    backoffMs: () => 4000,
    readyPollMs: 50,
  }));
  const out = durable.startWorkflowOnce("delivery", `delivery:${ADDRESS}:${message.id}`, { project: target.project, address: ADDRESS, message });
  while (!hold) await new Promise((resolve) => setTimeout(resolve, 10));
  const r = await hold;
  assert.equal(r.why, "messages");
  assert.ok(r.at - holdAt < 2000, `the hold got the message after ${r.at - holdAt} ms`);
  assert.equal(shown(r.text, "late for the hold"), 1, "the hold shows the message once");
  assert.equal((await out).status, "delivered", "the hand-off counts as delivered");
  assert.deepEqual(pushes, [], "nothing was pushed");
});

test("a message the dispatcher hands to a hold is delivered once, and the inbox does not show it again", { timeout: 20000 }, async (t) => {
  const { cfg, bob, target, frames, env } = await setup(t);
  let release = null;
  // The Stop hook marks itself between the dispatcher's ready check and its push.
  const claim = (scfg, opts) => {
    release ??= markStopRunning(target);
    return claimInbox(scfg, opts);
  };
  const dispatcher = createDispatcher({ projects: () => [cfg], env, claim, opencode: async () => ({ ok: true, status: 200, body: {} }), run: async () => 1 });
  const sent = await sendMessage(bob, ADDRESS, "handed by the dispatcher");
  await dispatcher.tick();
  release();
  assert.equal(frames.length, 0, "nothing went over the socket");
  assert.deepEqual((handoffMessages(target) ?? []).map((m) => m.id), [sent.id], "the message waits in the hand-off file");
  const started = Date.now();
  const r = await decideStop(target, HOLD);
  assert.equal(r.why, "messages");
  assert.ok(Date.now() - started < 2000);
  assert.equal(shown(r.text, "handed by the dispatcher"), 1, "the hold shows the message once");
  assert.equal((await claimInbox(target)).length, 0, "no later inbox read shows it");
});

test("a hand-off that outlives its hold wakes the session once through the next waiter", { timeout: 20000 }, async (t) => {
  const { cfg, bob, target, env } = await setup(t);
  let release = null;
  const claim = (scfg, opts) => {
    release ??= markStopRunning(target);
    return claimInbox(scfg, opts);
  };
  const dispatcher = createDispatcher({ projects: () => [cfg], env, claim, opencode: async () => ({ ok: true, status: 200, body: {} }), run: async () => 1 });
  const sent = await sendMessage(bob, ADDRESS, "left for the waiter");
  await dispatcher.tick();
  // The Stop hook ends without reading the hand-off.
  release();
  const r = await runWaiter(target, { maxMs: 3000 });
  assert.equal(r.code, 2);
  assert.equal(shown(r.text, "left for the waiter"), 1);
  assert.equal(existsSync(statePath(target).replace(/\.json$/, ".handoff.json")), false);
  assert.equal((await claimInbox(target)).length, 0, "the woken session's next inbox read does not show it again");
});

test("a hand-off taken before the push releases its reservation is not shown again by the inbox", { timeout: 20000 }, async (t) => {
  const { bob, target } = await setup(t);
  await sendMessage(bob, ADDRESS, "taken early");
  const [message] = await readInbox(target, { peek: true, strict: false });
  // The order inside a push that found a hold: reserve, hand off, then release; the waiter takes the hand-off in between.
  assert.deepEqual(await reserveDelivery(target, [message.id]), [message.id]);
  await handOff(target, [message]);
  const r = await runWaiter(target, { maxMs: 3000 });
  assert.equal(r.code, 2);
  assert.equal(shown(r.text, "taken early"), 1);
  await releaseDelivery(target, [message.id]);
  assert.equal((await claimInbox(target)).length, 0, "the released inbox copy is already marked delivered");
});
