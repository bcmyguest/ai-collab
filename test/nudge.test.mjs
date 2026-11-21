import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { publishStatus, urgentSince } from "../lib/inbox.mjs";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const base = "http://127.0.0.1:8795";

test("Send now on a queued message marks it urgent for that session's next hook", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  // Peers on one machine share a state dir; the marker lives there.
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "ai-collab-state-"));
  const cfg = loadConfig(peerEnv(fake, { peer: "alice", stateDir }));
  const bob = { ...loadConfig(peerEnv(fake, { peer: "bob", stateDir })), session: "0000000000000001" };
  await publishStatus(bob, { event: "start", harness: "codex" });
  const ui = createUi({ cfg });
  t.after(() => ui.close());
  const post = (body) => ui.handle(new Request(`${base}/api/nudge`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), "nudge");

  const before = Date.now() - 1;
  assert.equal(urgentSince(bob, before), false);
  assert.equal((await post({ target: `bob#${bob.session}` })).status, 200);
  assert.equal(urgentSince(bob, before), true);
  assert.equal((await post({ target: "all" })).status, 400, "only a session address can be nudged");
});
