import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { loadConfig, sessionLabel } from "../lib/config.ts";
import { writeOwned } from "../lib/sessions/registry.ts";
import { writeState } from "../lib/state.ts";
import { createUi } from "../web/server/ui.ts";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { firstUpdate } from "./helpers/ui-stream.mjs";

test("the phone stops and ends a runner-held agent of any harness through the runner", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const cfg = loadConfig(peerEnv(fake, { peer: "operator", AI_COLLAB_PEERS: "operator,claude" }));
  const nativeId = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
  const label = sessionLabel(nativeId);
  const address = "claude#" + label;
  writeState(join(cfg.stateDir, cfg.project, "registry", address + ".json"), {
    id: address, sessionId: nativeId, cwd: "/tmp", harness: "claude", seenAt: Date.now(),
  });
  const calls = [];
  const ui = createUi({ cfg, runner: () => ({
    async interrupt(target) { calls.push(["interrupt", target]); return { status: 202, body: { status: "succeeded" } }; },
    async close(target) { calls.push(["close", target]); return { status: 200, body: { status: "ended" } }; },
  }) });
  t.after(() => ui.close());
  const base = "http://127.0.0.1:8795";
  const post = (action) => ui.handle(new Request(base + "/api/" + action, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ target: address }),
  }), action);

  assert.equal((await post("end")).status, 404, "a session outside the runner cannot be ended");
  assert.deepEqual(calls, []);
  writeOwned(cfg, { label, address, harness: "claude", status: "running" });
  const view = await firstUpdate(ui.events(new Request(base + "/api/events?session=" + encodeURIComponent(address))), "state");
  assert.equal(view.agents.find(agent => agent.id === address).runnerStatus, "running");
  assert.equal((await post("interrupt")).status, 200);
  assert.equal((await post("end")).status, 200);
  assert.deepEqual(calls, [["interrupt", address], ["close", address]]);
});
