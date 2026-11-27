import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { loadConfig, sessionLabel } from "../lib/config.ts";
import { recordSession } from "../lib/sessions/registry.ts";
import { createUi } from "../web/server/ui.ts";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const base = "http://127.0.0.1:8795";

test("an @session tag in the project chat wakes that idle session", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = tempDir(t, "ai-collab-mention-wake-");
  const env = { ...peerEnv(fake, { peer: "operator", stateDir: path.join(home, "state"), AI_COLLAB_PEERS: "claude,cursor" }), HOME: home };
  const cfg = loadConfig(env);
  const pm = { ...loadConfig({ ...env, AI_COLLAB_PEER: "cursor" }), session: sessionLabel("p1") };
  await recordSession(pm, { id: "p1", cwd: home, harness: "cursor", event: "SessionEnd" });
  const address = `cursor#${pm.session}`;
  const wakes = [];
  const ui = createUi({ cfg, env, control: async (action, session) => { wakes.push([action, session.id]); return { status: "woken" }; }, start: async () => ({ status: "starting" }) });
  t.after(() => ui.close());
  const result = await ui.handle(new Request(`${base}/api/send`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ target: "all", body: `@${address} tell me when done` }),
  }), "send").then(r => r.json());
  assert.match(result.detail, /sent, waking/);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(wakes, [["wake", address]]);
});
