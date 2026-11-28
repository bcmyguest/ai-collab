import assert from "node:assert/strict";
import { test } from "node:test";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig, sessionLabel } from "../lib/config.ts";
import { claimInbox, sendMessage } from "../lib/messaging.ts";
import { respond } from "../lib/agents.ts";

test("respond refuses a message from a bare peer name instead of replying to every session of that peer", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const stateDir = peerEnv(fake).AI_COLLAB_STATE_DIR;
  const B = sessionLabel("session-b");
  const bare = loadConfig(peerEnv(fake, { peer: "opencode", stateDir, AI_COLLAB_SESSION: "" }));
  const bob = loadConfig(peerEnv(fake, { peer: "bob", stateDir, AI_COLLAB_SESSION: B }));
  await sendMessage(bare, `bob#${B}`, "don't restart the runner");
  const [m] = await claimInbox(bob);
  assert.equal(m.from, "opencode");
  const before = fake.state.publishes.length;
  await assert.rejects(respond(bob, m.id, "declined", "no"), /without a session.*every opencode session/);
  assert.equal(fake.state.publishes.length, before);
});
