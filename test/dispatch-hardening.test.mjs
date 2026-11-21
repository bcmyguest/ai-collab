import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { fakeClaudeHome, fakeClaudeSocket } from "./helpers/fake-claude.mjs";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { claimInbox, sendMessage } from "../lib/inbox.mjs";
import { processStart } from "../lib/process.mjs";
import { writeState } from "../lib/state.mjs";
import { createDispatcher } from "../web/server/dispatch.mjs";

const CODEX_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const CLAUDE_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6c";

// A registry entry for this process and the dispatcher under test; the codex run and clock are injectable.
async function setup(t, { harness = "codex", sessionId = CODEX_ID, cwd = "/tmp", run, claude, env, now } = {}) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const base = peerEnv(fake, { peer: "operator", AI_COLLAB_PEERS: "alice,bob,codex,claude" });
  const cfg = loadConfig(base);
  const label = sessionLabel(sessionId);
  const address = `${harness}#${label}`;
  const registry = join(cfg.stateDir, cfg.project, "registry");
  mkdirSync(registry, { recursive: true });
  writeState(join(registry, `${address}.json`), {
    id: address, sessionId, cwd, harness, event: "Stop", seenAt: Date.now(), pid: process.pid, pidStart: processStart(process.pid),
  });
  const bob = loadConfig(peerEnv(fake, { peer: "bob", AI_COLLAB_PEERS: base.AI_COLLAB_PEERS, AI_COLLAB_STATE_DIR: cfg.stateDir }));
  const target = loadConfig({ ...base, AI_COLLAB_PEER: harness }, { session: label });
  const dispatcher = createDispatcher({
    projects: () => [cfg],
    env: env ?? { HOME: cfg.stateDir },
    opencode: async () => ({ ok: true, status: 200, body: {} }),
    idle: async () => "idle",
    run: run ?? (async () => 0),
    ...(claude ? { claude } : {}),
    ...(now ? { now } : {}),
  });
  return { bob, target, address, dispatcher };
}

// A deferred promise with its resolver.
function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

test("a committed claim during a push that then fails leaves the message for the next claim", async (t) => {
  const entered = gate();
  const release = gate();
  const { bob, target, address, dispatcher } = await setup(t, {
    run: async () => {
      entered.open();
      await release.promise;
      return 1;
    },
  });
  await sendMessage(bob, address, "fails after a claim");
  const tick = dispatcher.tick();
  await entered.promise;
  assert.deepEqual(await claimInbox(target), [], "the committed claim skips the reserved message");
  release.open();
  assert.equal((await tick).delivered, 0);
  const got = await claimInbox(target);
  assert.equal(got.length, 1, "the failed push does not leave the message marked seen");
  assert.match(got[0].body, /fails after a claim/);
});

test("a failed push is retried with backoff, not on every tick", async (t) => {
  const base = Date.now();
  const clock = { t: base };
  let calls = 0;
  const { bob, address, dispatcher } = await setup(t, {
    now: () => clock.t,
    run: async () => {
      calls += 1;
      return 1;
    },
  });
  await sendMessage(bob, address, "keeps failing");
  await dispatcher.tick();
  assert.equal(calls, 1);
  clock.t = base + 1000;
  await dispatcher.tick();
  assert.equal(calls, 1, "still inside the first backoff");
  clock.t = base + 6000;
  await dispatcher.tick();
  assert.equal(calls, 2, "retried after the first backoff");
});

test("a late confirmation marks the message delivered without a second send", async (t) => {
  const sock = await fakeClaudeSocket(t, { accept: false });
  const claude = fakeClaudeHome(t, { sessionId: CLAUDE_ID, socket: sock.path });
  sock.state.transcript = claude.transcript;
  const { bob, target, address, dispatcher } = await setup(t, {
    harness: "claude", sessionId: CLAUDE_ID, cwd: claude.cwd,
    env: { HOME: claude.home, AI_COLLAB_CLAUDE_CONFIRM_MS: "200", AI_COLLAB_CLAUDE_WATCH_MS: "3000" },
  });
  await sendMessage(bob, address, "arrives late");
  assert.equal((await dispatcher.tick()).delivered, 0, "not confirmed inside the window");
  await delay(100);
  assert.equal(sock.frames.length, 1);
  const envelope = sock.frames[0].message.content;
  mkdirSync(dirname(claude.transcript), { recursive: true });
  appendFileSync(claude.transcript, `${JSON.stringify({ type: "queue-operation", operation: "enqueue", content: envelope })}\n`);
  await dispatcher.drain();
  assert.deepEqual(await claimInbox(target), [], "the watch marked it delivered");
  assert.equal((await dispatcher.tick()).delivered, 0);
  assert.equal(sock.frames.length, 1, "no second send");
});

test("a Claude message that never confirms is released to the hooks after the watch", async (t) => {
  const sock = await fakeClaudeSocket(t, { accept: false });
  const claude = fakeClaudeHome(t, { sessionId: CLAUDE_ID, socket: sock.path });
  sock.state.transcript = claude.transcript;
  const { bob, target, address, dispatcher } = await setup(t, {
    harness: "claude", sessionId: CLAUDE_ID, cwd: claude.cwd,
    env: { HOME: claude.home, AI_COLLAB_CLAUDE_CONFIRM_MS: "200", AI_COLLAB_CLAUDE_WATCH_MS: "200" },
  });
  await sendMessage(bob, address, "never confirmed");
  await dispatcher.tick();
  await dispatcher.drain();
  const got = await claimInbox(target);
  assert.equal(got.length, 1);
  assert.match(got[0].body, /never confirmed/);
});
