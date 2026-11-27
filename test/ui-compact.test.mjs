// The Compact action and /compact reach the runner's real harness compaction for owned sessions, and fall back to
// lib/sessions/control.ts for a terminal session. The runner client is injected, so nothing here talks to a socket.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, sessionLabel } from "../lib/config.ts";
import { writeState } from "../lib/state.ts";
import { createUi } from "../web/server/ui.ts";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const base = "http://127.0.0.1:8795";
const CLAUDE_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

function registered(cfg, harness, sessionId) {
  const address = `${harness}#${sessionLabel(sessionId)}`;
  mkdirSync(join(cfg.stateDir, cfg.project, "registry"), { recursive: true });
  writeState(join(cfg.stateDir, cfg.project, "registry", `${address}.json`), { id: address, sessionId, cwd: "/tmp", harness, seenAt: Date.now() });
  return address;
}

const post = (ui, path) => (body) => ui.handle(new Request(`${base}/api/${path}`, {
  method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body),
}), path);

test("Compact on an owned session asks the runner for real compaction, not a message", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const cfg = loadConfig(peerEnv(fake, { peer: "operator", AI_COLLAB_PEERS: "alice,claude" }));
  const address = registered(cfg, "claude", CLAUDE_ID);
  const runnerCalls = [];
  const controlCalls = [];
  const runner = () => ({ compact: async (target) => { runnerCalls.push(target); return { status: 200, body: { status: "succeeded", detail: "Compacted the session in place. 90000 → 20000 tokens.", before: 90000, after: 20000 } }; } });
  const ui = createUi({ cfg, env: process.env, runner, control: async (action, peer) => { controlCalls.push([action, peer?.id]); return { status: "requested", detail: "asked" }; } });
  t.after(() => ui.close());

  const res = await post(ui, "compact")({ target: address });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "succeeded", detail: "Compacted the session in place. 90000 → 20000 tokens.", before: 90000, after: 20000 });
  assert.deepEqual(runnerCalls, [address], "the runner got the compaction");
  assert.deepEqual(controlCalls, [], "no message-request fallback when the runner compacted");
});

test("Compact falls back to the control path when the runner does not own the session", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const cfg = loadConfig(peerEnv(fake, { peer: "operator", AI_COLLAB_PEERS: "alice,claude" }));
  const address = registered(cfg, "claude", CLAUDE_ID);
  const controlCalls = [];
  const runner = () => ({ compact: async () => { throw new Error("connect ENOENT"); } });
  const ui = createUi({ cfg, env: process.env, runner, control: async (action, peer) => { controlCalls.push([action, peer?.id]); return { status: "requested", detail: "asked the session" }; } });
  t.after(() => ui.close());

  const res = await post(ui, "compact")({ target: address });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "requested", detail: "asked the session" });
  assert.deepEqual(controlCalls, [["compact", address]]);
});

test("/compact typed in a session's composer reaches the runner's real compaction", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const cfg = loadConfig(peerEnv(fake, { peer: "operator", AI_COLLAB_PEERS: "alice,claude" }));
  const address = registered(cfg, "claude", CLAUDE_ID);
  const runnerCalls = [];
  const controlCalls = [];
  const runner = () => ({ compact: async (target) => { runnerCalls.push(target); return { status: 200, body: { status: "succeeded", detail: "Compacted the session in place." } }; } });
  const ui = createUi({ cfg, env: process.env, runner, control: async (action, peer) => { controlCalls.push([action, peer?.id]); return { status: "requested", detail: "asked" }; } });
  t.after(() => ui.close());

  const res = await post(ui, "command")({ target: address, command: "/compact" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "succeeded", detail: "Compacted the session in place." });
  assert.deepEqual(runnerCalls, [address]);
  assert.deepEqual(controlCalls, []);
});

test("the runner's mid-turn refusal is reported, not hidden behind a message request", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const cfg = loadConfig(peerEnv(fake, { peer: "operator", AI_COLLAB_PEERS: "alice,claude" }));
  const address = registered(cfg, "claude", CLAUDE_ID);
  const controlCalls = [];
  const runner = () => ({ compact: async () => ({ status: 409, body: { error: "The session is mid-turn; compact it once the turn ends" } }) });
  const ui = createUi({ cfg, env: process.env, runner, control: async (action, peer) => { controlCalls.push([action, peer?.id]); return { status: "requested", detail: "asked" }; } });
  t.after(() => ui.close());

  const res = await post(ui, "compact")({ target: address });
  assert.deepEqual(await res.json(), { status: "failed", detail: "The session is mid-turn; compact it once the turn ends" });
  assert.deepEqual(controlCalls, [], "the runner owns the session, so no message is posted");
});
