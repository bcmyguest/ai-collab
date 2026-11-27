import assert from "node:assert/strict";
import test from "node:test";
import { sessionLabel } from "../lib/config.ts";
import { listSessions, recordSession } from "../lib/sessions.mjs";
import { tempDir } from "./helpers/tmp.mjs";

test("a session keeps the model its hooks report until a later hook reports another", async (t) => {
  const dir = tempDir(t, "session-model-");
  const id = "11111111-2222-3333-4444-555555555555";
  const cfg = { stateDir: dir, project: "demo", peer: "cursor", session: sessionLabel(id), peers: [] };
  await recordSession(cfg, { id, cwd: dir, harness: "cursor", event: "start", model: "composer-2.5" });
  assert.equal(listSessions(cfg)[0].model, "composer-2.5");
  await recordSession(cfg, { id, cwd: dir, harness: "cursor", event: "prompt" });
  assert.equal(listSessions(cfg)[0].model, "composer-2.5");
  await recordSession(cfg, { id, cwd: dir, harness: "cursor", event: "prompt", model: "bad name;rm" });
  assert.equal(listSessions(cfg)[0].model, "composer-2.5");
  await recordSession(cfg, { id, cwd: dir, harness: "cursor", event: "prompt", model: "gpt-6.2-sol" });
  assert.equal(listSessions(cfg)[0].model, "gpt-6.2-sol");
});
