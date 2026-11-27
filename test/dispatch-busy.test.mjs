import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig, sessionLabel } from "../lib/config.ts";
import { sendMessage } from "../lib/inbox.mjs";
import { processStart } from "../lib/process.ts";
import { writeState } from "../lib/state.ts";
import { REDELIVER_MS, createDispatcher } from "../web/server/dispatch.mjs";

const OPENCODE_ID = "ses_0123456789abcdefghijABCDEFGH";

test("an OpenCode session with a running turn gets no redelivery of an unanswered expect_reply message", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "operator", AI_COLLAB_PEERS: "alice,bob,opencode" });
  const cfg = loadConfig(env);
  const address = `opencode#${sessionLabel(OPENCODE_ID)}`;
  const registry = join(cfg.stateDir, cfg.project, "registry");
  mkdirSync(registry, { recursive: true });
  writeState(join(registry, `${address}.json`), {
    id: address, sessionId: OPENCODE_ID, cwd: "/tmp", harness: "opencode", event: "Stop", seenAt: Date.now(), pid: process.pid, pidStart: processStart(process.pid),
  });
  const bob = loadConfig(peerEnv(fake, { peer: "bob", AI_COLLAB_PEERS: env.AI_COLLAB_PEERS, AI_COLLAB_STATE_DIR: cfg.stateDir }));
  const clock = { t: Date.now() };
  const prompts = [];
  let working = false;
  const dispatcher = createDispatcher({
    projects: () => [cfg], now: () => clock.t, env: { HOME: cfg.stateDir },
    opencode: async (method, path, options) => {
      if (method === "GET") return { ok: true, status: 200, body: { data: working ? { [OPENCODE_ID]: {} } : {} } };
      prompts.push(options.body.text);
      return { ok: true, status: 200, body: {} };
    },
  });
  await sendMessage(bob, address, "need an answer", { expectReply: true });
  await dispatcher.tick();
  assert.equal(prompts.length, 1);

  working = true;
  clock.t += REDELIVER_MS + 1000;
  assert.equal((await dispatcher.tick()).redelivered, 0);
  assert.equal(prompts.length, 1, "a copy was queued behind the running turn");

  working = false;
  assert.equal((await dispatcher.tick()).redelivered, 1);
  assert.equal(prompts.length, 2);
});
