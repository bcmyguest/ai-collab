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
const CODEX_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

test("the interrupt action passes the registered session to the interrupt function", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const cfg = loadConfig(peerEnv(fake, { peer: "alice", AI_COLLAB_PEERS: "alice,codex" }));
  const address = `codex#${sessionLabel(CODEX_ID)}`;
  mkdirSync(join(cfg.stateDir, cfg.project, "registry"), { recursive: true });
  writeState(join(cfg.stateDir, cfg.project, "registry", `${address}.json`), { id: address, sessionId: CODEX_ID, cwd: "/tmp", harness: "codex", seenAt: Date.now() });
  const seen = [];
  const ui = createUi({ cfg, interrupt: async (session) => { seen.push(session); return { status: "succeeded", detail: "done" }; } });
  t.after(() => ui.close());
  const post = (body) => ui.handle(new Request(`${base}/api/interrupt`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), "interrupt");

  const ok = await post({ target: address });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { status: "succeeded", detail: "done" });
  assert.equal(seen[0].sessionId, CODEX_ID);
  assert.equal((await post({ target: "all" })).status, 400, "only a session address can be interrupted");
  const unknown = await post({ target: `codex#${"0".repeat(16)}` });
  assert.equal(unknown.status, 200);
  assert.deepEqual([seen.length, seen[1]], [2, undefined], "an unregistered session reaches the function as undefined");
  const cross = await ui.handle(new Request(`${base}/api/interrupt`, {
    method: "POST", headers: { Origin: "http://evil.example", "Content-Type": "application/json" }, body: JSON.stringify({ target: address }),
  }), "interrupt");
  assert.equal(cross.status, 403);
});
