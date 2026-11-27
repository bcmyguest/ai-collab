import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { fakeClaudeHome, fakeClaudeSocket } from "./helpers/fake-claude.mjs";
import { loadConfig, sessionLabel } from "../lib/config.ts";
import { claimInbox, sendMessage } from "../lib/inbox.mjs";
import { processStart } from "../lib/process.ts";
import { writeState } from "../lib/state.ts";
import { createDispatcher } from "../web/server/dispatch.mjs";

const CODEX_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const CLAUDE_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6c";

// A registry entry for this process; harness codex (idle on Stop) or claude (socket).
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

test("a message taken by the waiter while its push is paused is not taken twice", async (t) => {
  const entered = gate();
  const release = gate();
  const pushes = [];
  const { bob, target, address, dispatcher } = await setup(t, {
    run: async (file, args) => {
      pushes.push(args);
      entered.open();
      await release.promise;
      return 0;
    },
  });
  await sendMessage(bob, address, "race me");
  const tick = dispatcher.tick();
  await entered.promise;
  assert.deepEqual(await claimInbox(target), [], "the waiter's claim sees the reservation");
  release.open();
  assert.equal((await tick).delivered, 1);
  assert.equal(pushes.length, 1);
  assert.deepEqual(await claimInbox(target), [], "delivered messages stay delivered");
});

test("a failed push releases the reservation so the hooks or waiter can take the message", async (t) => {
  const { bob, target, address, dispatcher } = await setup(t, { run: async () => 1 });
  await sendMessage(bob, address, "push fails");
  assert.equal((await dispatcher.tick()).delivered, 0);
  const got = await claimInbox(target);
  assert.equal(got.length, 1);
  assert.match(got[0].body, /push fails/);
});

test("fyi messages ahead of a direct message do not starve it", async (t) => {
  const pushed = [];
  const { bob, address, dispatcher } = await setup(t, { run: async (file, args) => { pushed.push(args); return 0; } });
  for (let i = 0; i < 6; i += 1) await sendMessage(bob, address, `fyi ${i}`, { priority: "fyi" });
  await sendMessage(bob, address, "the direct one");
  assert.equal((await dispatcher.tick()).delivered, 1);
  assert.equal(pushed.length, 1);
  assert.match(pushed[0][4], /the direct one/);
});

test("a Claude session that refuses the message keeps it for the hooks", async (t) => {
  const sock = await fakeClaudeSocket(t, { accept: false });
  const claude = fakeClaudeHome(t, { sessionId: CLAUDE_ID, socket: sock.path });
  sock.state.transcript = claude.transcript;
  const { bob, target, address, dispatcher } = await setup(t, {
    harness: "claude", sessionId: CLAUDE_ID, cwd: claude.cwd, env: { HOME: claude.home, AI_COLLAB_CLAUDE_CONFIRM_MS: "300", AI_COLLAB_CLAUDE_WATCH_MS: "0" },
  });
  await sendMessage(bob, address, "refused by claude");
  assert.equal((await dispatcher.tick()).delivered, 0);
  await dispatcher.drain();
  const got = await claimInbox(target);
  assert.equal(got.length, 1, "the message stays unread for the hooks");
  assert.equal(sock.frames.length, 1);
});

test("a Claude session that confirms the message gets it once", async (t) => {
  const sock = await fakeClaudeSocket(t);
  const claude = fakeClaudeHome(t, { sessionId: CLAUDE_ID, socket: sock.path });
  sock.state.transcript = claude.transcript;
  const { bob, target, address, dispatcher } = await setup(t, {
    harness: "claude", sessionId: CLAUDE_ID, cwd: claude.cwd, env: { HOME: claude.home, AI_COLLAB_CLAUDE_CONFIRM_MS: "3000" },
  });
  await sendMessage(bob, address, "delivered once");
  assert.equal((await dispatcher.tick()).delivered, 1);
  assert.deepEqual(await claimInbox(target), []);
  assert.equal((await dispatcher.tick()).delivered, 0);
  assert.equal(sock.frames.length, 1);
});
