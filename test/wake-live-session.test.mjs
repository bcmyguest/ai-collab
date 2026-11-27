// A live session is never woken: no wake control runs and no "Waking the selected session." notice shows.
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { recordSession } from "../lib/sessions.mjs";
import { writeOwned } from "../lib/sessions/registry.ts";
import { publishStatus } from "../lib/inbox.mjs";
import { visibleWake } from "../web/lib/session-state.js";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { firstUpdate } from "./helpers/ui-stream.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const base = "http://127.0.0.1:8799";
const NATIVE_ID = "11111111-0000-4000-8000-00000000000a";
const LABEL = sessionLabel(NATIVE_ID);
const ADDRESS = `claude#${LABEL}`;

// A UI whose wake control is recorded; prepare runs before createUi, and the first state event
// proves the status topic has been loaded, so a fresh status is visible before the send.
async function setup(t, prepare) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = tempDir(t, "ai-collab-wake-live-");
  const env = { ...peerEnv(fake, { peer: "operator", stateDir: path.join(home, "state"), AI_COLLAB_PEERS: "claude,codex" }), HOME: home };
  const cfg = loadConfig(env);
  if (prepare) await prepare(cfg);
  const calls = [];
  const ui = createUi({
    cfg, env,
    control: async (action, session) => { calls.push([action, session.id]); return { status: "woken" }; },
    start: async () => ({ status: "starting" }),
  });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  await firstUpdate(ui.events(new Request(`${base}/api/events`, { signal: ctrl.signal })), "state");
  return { cfg, ui, calls };
}

async function send(ui, target) {
  const response = await ui.handle(new Request(`${base}/api/send`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ target, body: "still there?" }),
  }), "send");
  return response.json();
}

for (const status of ["running", "idle"]) {
  test(`a send to a runner-owned ${status} session is not woken and shows no waking notice`, async (t) => {
    const { cfg, ui, calls } = await setup(t, async cfg => {
      await recordSession({ ...cfg, peer: "claude", session: LABEL }, { id: NATIVE_ID, cwd: cfg.stateDir, harness: "claude", event: "Stop" });
      writeOwned(cfg, { label: LABEL, address: ADDRESS, harness: "claude", status, run: null, approvals: [] });
    });
    const result = await send(ui, ADDRESS);
    assert.equal(result.wake?.status, "online", JSON.stringify(result));
    assert.ok(!result.wake?.detail, "no waking notice");
    assert.deepEqual(calls, [], "no wake control ran");
  });
}

test("a send to a hook session mid-turn (a fresh start status, no visible process) is not woken", async (t) => {
  const { ui, calls } = await setup(t, async cfg => {
    await recordSession({ ...cfg, peer: "claude", session: LABEL }, { id: NATIVE_ID, cwd: cfg.stateDir, harness: "claude", event: "PostToolUse" });
    await publishStatus({ ...cfg, peer: "claude", session: LABEL }, { event: "start", harness: "claude" });
  });
  const result = await send(ui, ADDRESS);
  assert.equal(result.wake?.status, "online", JSON.stringify(result));
  assert.ok(!result.wake?.detail, "no waking notice");
  assert.deepEqual(calls, [], "no wake control ran");
});

test("a send to a session that is really offline still wakes it", async (t) => {
  const { cfg, ui, calls } = await setup(t, async cfg => {
    await recordSession({ ...cfg, peer: "claude", session: LABEL }, { id: NATIVE_ID, cwd: cfg.stateDir, harness: "claude", event: "SessionEnd" });
  });
  const result = await send(ui, ADDRESS);
  assert.equal(result.wake?.status, "waking");
  assert.equal(result.wake?.detail, "Waking the selected session.");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(calls, [["wake", ADDRESS]]);
});

test("a waking notice hides while the session is online", () => {
  const waking = { status: "waking", detail: "Waking the selected session.", at: 1000 };
  assert.equal(visibleWake(waking, { online: true, seenAt: 900 }), null);
  assert.equal(visibleWake(waking, { online: false, seenAt: 900 }), waking, "an offline session keeps the notice");
});
