// A message the dispatcher handed to a hold stays delivered after its reservation would have expired.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig, sessionLabel } from "../lib/config.ts";
import { claimInbox, sendMessage } from "../lib/inbox.mjs";
import { RESERVE_MS } from "../lib/messaging.ts";
import { markStopRunning } from "../lib/stop.ts";
import { processStart } from "../lib/process.ts";
import { writeState } from "../lib/state.ts";
import { createDispatcher } from "../web/server/dispatch.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const CLAUDE_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const LABEL = sessionLabel(CLAUDE_ID);
const ADDRESS = `claude#${LABEL}`;

// A registered Claude session whose record under HOME/.claude points at a listening fake socket with an open gate.
async function setup(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "operator", AI_COLLAB_PEERS: "bob,claude" });
  const cfg = loadConfig(env);
  const registry = join(cfg.stateDir, cfg.project, "registry");
  mkdirSync(registry, { recursive: true });
  const home = cfg.stateDir;
  const claudeDir = join(home, ".claude");
  mkdirSync(join(claudeDir, "sessions"), { recursive: true });
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ crossSessionInbound: "accept" }));
  writeState(join(registry, `${ADDRESS}.json`), {
    id: ADDRESS, sessionId: CLAUDE_ID, cwd: "/tmp", harness: "claude", event: "Stop", seenAt: Date.now(), pid: process.pid, pidStart: processStart(process.pid),
  });
  const frames = [];
  const socketPath = join(tempDir({ after }, "dhe-sock-"), "s.sock");
  t.after(() => rmSync(socketPath, { force: true }));
  const server = createServer((conn) => conn.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) frames.push(JSON.parse(line));
  }));
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  writeFileSync(join(claudeDir, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: CLAUDE_ID, status: "idle", cwd: "/tmp", messagingSocketPath: socketPath }));
  writeFileSync(join(claudeDir, "sessions", `${process.pid}.k1.key`), "peer-token\n");
  const bob = loadConfig(peerEnv(fake, { peer: "bob", AI_COLLAB_PEERS: env.AI_COLLAB_PEERS, AI_COLLAB_STATE_DIR: cfg.stateDir }));
  const target = loadConfig({ ...env, AI_COLLAB_PEER: "claude" }, { session: LABEL });
  return { cfg, bob, target, frames, env: { HOME: home } };
}

const sent = (frames, text) => frames.some((f) => f.type === "user" && String(f.message?.content ?? "").includes(text));

test("a message handed to a hold is not pushed again once its reservation would have expired", async (t) => {
  const { cfg, bob, target, frames, env } = await setup(t);
  let release = null;
  // The Stop hook marks itself between the ready check and the push, so the dispatcher hands the message off.
  const claim = (scfg, opts) => {
    release ??= markStopRunning(target);
    return claimInbox(scfg, opts);
  };
  // A skewed clock that keeps ticking, so deadline loops still end; reservations read Date.now.
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  t.after(() => { Date.now = realNow; });
  // A short confirm window, so the late watcher of the control push ends before the clock is restored.
  const fast = { ...env, AI_COLLAB_CLAUDE_CONFIRM_MS: "100", AI_COLLAB_CLAUDE_WATCH_MS: "0" };
  const dispatcher = createDispatcher({ projects: () => [cfg], env: fast, claim, now: () => Date.now(), opencode: async () => ({ ok: true, status: 200, body: {} }), run: async () => 1 });
  await sendMessage(bob, ADDRESS, "handed in the gap");
  assert.equal((await dispatcher.tick()).delivered, 1);
  assert.equal(frames.length, 0, "nothing went over the socket");
  release();

  skew = RESERVE_MS + 1000;
  await sendMessage(bob, ADDRESS, "after the expiry");
  await dispatcher.tick();
  assert.ok(sent(frames, "after the expiry"), "the session takes pushes again");
  assert.equal(sent(frames, "handed in the gap"), false, "the handed message is not pushed again");
  await dispatcher.drain();
});
