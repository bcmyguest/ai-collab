import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { recordSession, setIdentity } from "../lib/sessions.mjs";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { firstUpdate } from "./helpers/ui-stream.mjs";

const base = "http://127.0.0.1:8795";
const self = () => {
  const text = readFileSync("/proc/self/stat", "utf8");
  return { pid: process.pid, start: text.slice(text.lastIndexOf(")") + 2).split(" ")[19] };
};

test("the sidebar's agents carry the set_identity name, apart from a harness title", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "ai-collab-named-"));
  const pmId = "named-pm-session";
  const plainId = "named-plain-session";
  const env = peerEnv(fake, { peer: "operator", stateDir });
  const pm = loadConfig(peerEnv(fake, { peer: "alice", stateDir, AI_COLLAB_SESSION: sessionLabel(pmId) }));
  const plain = loadConfig(peerEnv(fake, { peer: "alice", stateDir, AI_COLLAB_SESSION: sessionLabel(plainId) }));
  await recordSession(pm, { id: pmId, cwd: "/tmp", harness: "claude", event: "SessionStart", proc: self() });
  await setIdentity(pm, { name: "PM", activity: "watching builders", tags: ["role:pm"] });
  await recordSession(plain, { id: plainId, cwd: "/tmp", harness: "claude", event: "SessionStart", proc: self(), name: "Fix the login test" });

  const ui = createUi({ cfg: loadConfig(env), env });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const state = await firstUpdate(ui.events(new Request(`${base}/api/events`, { signal: ctrl.signal })), "state");
  const by = Object.fromEntries(state.agents.map(agent => [agent.id, agent]));
  assert.equal(by[`alice#${sessionLabel(pmId)}`].identityName, "PM");
  assert.equal(by[`alice#${sessionLabel(pmId)}`].name, "PM");
  assert.equal(by[`alice#${sessionLabel(pmId)}`].activity, "watching builders");
  assert.equal(by[`alice#${sessionLabel(plainId)}`].identityName, undefined, "a harness title is not an agent name");
  assert.equal(by[`alice#${sessionLabel(plainId)}`].name, "Fix the login test");
});
