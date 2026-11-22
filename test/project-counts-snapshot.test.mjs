import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../lib/config.mjs";
import { publishStatus } from "../lib/inbox.mjs";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";

const base = "http://127.0.0.1:8795";

test("the snapshot's projectCounts counts each project's online and offline sessions", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "alice" });
  const online = { ...loadConfig(peerEnv(fake, { peer: "bob" })), session: "0000000000000001" };
  const offline = { ...loadConfig(peerEnv(fake, { peer: "bob" })), session: "0000000000000002" };
  await publishStatus(online, { event: "start", harness: "codex" });
  await publishStatus(offline, { event: "start", harness: "codex" });
  await publishStatus(offline, { event: "stop", harness: "codex" });
  const ui = createUi({ cfg: loadConfig(env), env });
  t.after(() => ui.close());
  const ctrl = new AbortController();
  const stream = sse(ui.events(new Request(`${base}/api/events`, { signal: ctrl.signal })));
  const first = (await stream.next()).value;
  ctrl.abort();
  assert.deepEqual(first.data.projectCounts, { demo: { running: 1, inactive: 1 } });
});
