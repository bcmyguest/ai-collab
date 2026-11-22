import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { transcriptPath } from "./helpers/fake-claude.mjs";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { claimInbox, sendMessage } from "../lib/inbox.mjs";
import { processStart } from "../lib/process.mjs";
import { writeState } from "../lib/state.mjs";
import { createDispatcher } from "../web/server/dispatch.mjs";

const CLAUDE_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

// A Claude session whose record points at a fake messaging socket under HOME/.claude; gate sets crossSessionInbound.
async function setup(t, { gate = "accept", listen = true } = {}) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "operator", AI_COLLAB_PEERS: "alice,bob,claude" });
  const cfg = loadConfig(env);
  const label = sessionLabel(CLAUDE_ID);
  const address = `claude#${label}`;
  const registry = join(cfg.stateDir, cfg.project, "registry");
  mkdirSync(registry, { recursive: true });
  const home = cfg.stateDir;
  const claudeDir = join(home, ".claude");
  mkdirSync(join(claudeDir, "sessions"), { recursive: true });
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ crossSessionInbound: gate }));
  writeState(join(registry, `${address}.json`), {
    id: address, sessionId: CLAUDE_ID, cwd: "/tmp", harness: "claude", event: "PreToolUse", seenAt: Date.now(), pid: process.pid, pidStart: processStart(process.pid),
  });
  const frames = [];
  const socketPath = join(mkdtempSync(join(tmpdir(), "dc-sock-")), "s.sock");
  t.after(() => rmSync(socketPath, { force: true }));
  // The registry cwd is /tmp; Claude's transcript for it is projects/-tmp/<session>.jsonl under this home.
  const transcript = transcriptPath(home, "/tmp", CLAUDE_ID);
  let server = null;
  if (listen) {
    let buffer = "";
    server = createServer((conn) => conn.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const frame = JSON.parse(buffer.slice(0, i));
        frames.push(frame);
        buffer = buffer.slice(i + 1);
        // Claude records a delivered user frame in the transcript; a gate that holds it would not.
        if (frame.type === "user" && gate === "accept") {
          mkdirSync(join(transcript, ".."), { recursive: true });
          appendFileSync(transcript, `${JSON.stringify({ type: "queue-operation", operation: "enqueue", content: frame.message.content })}\n`);
        }
      }
    }));
    await new Promise((resolve) => server.listen(socketPath, resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
  }
  writeFileSync(join(claudeDir, "sessions", `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId: CLAUDE_ID, status: "idle", cwd: "/tmp", ...(listen ? { messagingSocketPath: socketPath } : {}),
  }));
  writeFileSync(join(claudeDir, "sessions", `${process.pid}.k1.key`), "peer-token\n");
  const bob = loadConfig(peerEnv(fake, { peer: "bob", AI_COLLAB_PEERS: env.AI_COLLAB_PEERS, AI_COLLAB_STATE_DIR: cfg.stateDir }));
  const target = loadConfig({ ...env, AI_COLLAB_PEER: "claude" }, { session: label });
  const dispatcher = createDispatcher({
    projects: () => [cfg],
    env: { HOME: home },
    opencode: async () => ({ ok: true, status: 200, body: {} }),
    run: async () => 1,
  });
  return { bob, target, address, dispatcher, frames };
}

const settle = () => new Promise((r) => setTimeout(r, 100));

test("a direct message reaches an open-gate Claude session over its socket and hooks skip it", async (t) => {
  const { bob, target, address, dispatcher, frames } = await setup(t);
  await sendMessage(bob, address, "please review", { urgent: true, expectReply: true });
  assert.equal((await dispatcher.tick()).delivered, 1);
  await settle();
  assert.equal(frames.length, 2);
  assert.equal(frames[0].type, "auth");
  assert.equal(frames[1].priority, "next");
  const content = frames[1].message.content;
  assert.match(content, /please review/);
  assert.match(content, /from=bob/);
  assert.match(content, /untrusted/);
  assert.match(content, /respond message_id=m\w+ state=working/);
  assert.deepEqual(await claimInbox(target), []);
});

test("with crossSessionInbound on hold the message stays for the hooks", async (t) => {
  const { bob, target, address, dispatcher, frames } = await setup(t, { gate: "hold" });
  await sendMessage(bob, address, "wait for hooks");
  assert.equal((await dispatcher.tick()).delivered, 0);
  await settle();
  assert.equal(frames.length, 0);
  assert.equal((await claimInbox(target)).length, 1);
});

test("a failed socket send leaves the message for the hooks", async (t) => {
  const { bob, target, address, dispatcher } = await setup(t, { listen: false });
  await sendMessage(bob, address, "no socket");
  assert.equal((await dispatcher.tick()).delivered, 0);
  assert.equal((await claimInbox(target)).length, 1);
});

test("an fyi message is never pushed to a Claude session", async (t) => {
  const { bob, target, address, dispatcher, frames } = await setup(t);
  await sendMessage(bob, address, "just so you know", { priority: "fyi" });
  assert.equal((await dispatcher.tick()).delivered, 0);
  await settle();
  assert.equal(frames.length, 0);
  assert.equal((await claimInbox(target)).length, 1);
});
