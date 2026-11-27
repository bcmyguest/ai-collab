// A waiter aborted mid-settle hands its claimed messages to a Stop hook that marks itself shortly after the abort.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig, sessionLabel } from "../lib/config.ts";
import { claimInbox, sendMessage } from "../lib/messaging.ts";
import { statePath } from "../lib/state.ts";
import { runWaiter } from "../lib/waiter.ts";

const LABEL = sessionLabel("99999999-2222-3333-4444-666666666666");

function handoff(cfg) {
  try { return JSON.parse(readFileSync(statePath(cfg).replace(/\.json$/, ".handoff.json"), "utf8")).messages; } catch { return null; }
}

test("a waiter aborted mid-settle hands off once the Stop hook marks itself 200 ms after the abort", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "claude", AI_COLLAB_PEERS: "claude,bob" });
  const cfg = loadConfig(env, { session: LABEL });
  const bob = loadConfig(peerEnv(fake, { peer: "bob", AI_COLLAB_PEERS: "claude,bob", AI_COLLAB_STATE_DIR: env.AI_COLLAB_STATE_DIR }));
  await claimInbox(cfg);
  await sendMessage(bob, `claude#${LABEL}`, "settling");
  const ac = new AbortController();
  let abortedAt = 0;
  // The abort fires 200 ms after the waiter first sees the message, inside its 1000 ms settle.
  const claim = async (...args) => {
    const got = await claimInbox(...args);
    if (got.length && !abortedAt) setTimeout(() => { abortedAt = Date.now(); ac.abort(); }, 200);
    return got;
  };
  const held = () => abortedAt > 0 && Date.now() >= abortedAt + 200;
  const r = await runWaiter(cfg, { maxMs: 5000, settleMs: 1000, signal: ac.signal, claim, held });
  assert.ok(abortedAt > 0, "the abort fired");
  assert.notEqual(r.code, 2, "the aborted waiter did not wake the session");
  assert.equal(r.code, 0);
  assert.deepEqual((handoff(cfg) ?? []).map((m) => m.body), ["settling"], "the message waits in the hand-off file");
});
