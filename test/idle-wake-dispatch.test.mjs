// A pushed message waits while the target Claude session's Stop hook holds: the hold delivers it through the inbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { claimInbox, sendMessage } from "../lib/inbox.mjs";
import { readySession } from "../lib/deliver-push.mjs";
import { markStopRunning } from "../lib/stop.mjs";
import { processStart } from "../lib/process.mjs";
import { writeState } from "../lib/state.mjs";
import { createDispatcher } from "../web/server/dispatch.mjs";

const CLAUDE_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
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
  const socketPath = join(mkdtempSync(join(tmpdir(), "iwd-sock-")), "s.sock");
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
  const session = { id: ADDRESS, harness: "claude", sessionId: CLAUDE_ID, peer: "claude", session: LABEL, cwd: "/tmp", pid: process.pid, pidStart: processStart(process.pid) };
  return { cfg, bob, target, session, frames, env: { HOME: home } };
}

test("a Claude session is not ready for a push while its Stop hook runs", async (t) => {
  const { cfg, target, session, env } = await setup(t);
  assert.equal(await readySession(session, null, { env, cfg }), true);
  const release = markStopRunning(target);
  assert.equal(await readySession(session, null, { env, cfg }), false, "the hold delivers instead");
  release();
  assert.equal(await readySession(session, null, { env, cfg }), true);
});

test("the dispatcher leaves a direct message to a holding Claude session for the hold, then pushes once it ends", async (t) => {
  const { cfg, bob, target, frames, env } = await setup(t);
  const dispatcher = createDispatcher({ projects: () => [cfg], env, opencode: async () => ({ ok: true, status: 200, body: {} }), run: async () => 1 });
  const release = markStopRunning(target);
  await sendMessage(bob, ADDRESS, "during the hold");
  assert.equal((await dispatcher.tick()).delivered, 0);
  assert.equal(frames.length, 0, "nothing went over the socket");
  const held = await claimInbox(target);
  assert.equal(held.length, 1, "the hold's inbox read still sees the message");
  release();
  await sendMessage(bob, ADDRESS, "after the hold");
  await dispatcher.tick();
  // The fake socket never confirms in a transcript, so the push counts as sent, not delivered.
  assert.match(frames.find((f) => f.type === "user")?.message.content ?? "", /after the hold/);
});

test("the dispatcher releases a claimed message when a Stop hook starts between its ready check and the push", async (t) => {
  const { cfg, bob, target, frames, env } = await setup(t);
  let release = null;
  // The claim runs after the ready check and before the push: the Stop hook marks itself in that gap.
  const claim = (scfg, opts) => {
    release ??= markStopRunning(target);
    return claimInbox(scfg, opts);
  };
  const dispatcher = createDispatcher({ projects: () => [cfg], env, claim, opencode: async () => ({ ok: true, status: 200, body: {} }), run: async () => 1 });
  await sendMessage(bob, ADDRESS, "in the gap");
  assert.equal((await dispatcher.tick()).delivered, 0);
  assert.equal(frames.length, 0, "nothing went over the socket");
  const held = await claimInbox(target);
  assert.equal(held.length, 1, "the released message is in the hold's inbox read");
  release();
});
