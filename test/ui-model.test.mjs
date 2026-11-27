import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { loadConfig, sessionLabel } from "../lib/config.ts";
import { writeOwned } from "../lib/sessions/registry.ts";
import { writeState } from "../lib/state.ts";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { firstUpdate } from "./helpers/ui-stream.mjs";

test("the phone exposes and routes model switching only for the selected owned Claude session", async (t) => {
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
    async setModel(target, model) {
      calls.push([target, model]);
      return { status: 200, body: { model } };
    },
  }) });
  t.after(() => ui.close());
  const base = "http://127.0.0.1:8795";
  const post = () => ui.handle(new Request(base + "/api/model", {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ target: address, model: "sonnet" }),
  }), "model");

  assert.equal((await post()).status, 404);
  assert.deepEqual(calls, []);
  writeOwned(cfg, { label, address, harness: "claude", status: "idle", model: "opus" });
  const view = await firstUpdate(ui.events(new Request(base + "/api/events?session=" + encodeURIComponent(address))), "state");
  assert.deepEqual(view.agents.find(agent => agent.id === address).modelControl, { current: "opus", busy: false });
  const changed = await post();
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), { model: "sonnet" });
  assert.deepEqual(calls, [[address, "sonnet"]]);
});
