// A click refused for a wrong hash closes the card, and the UI must hear about it at once: its folder watch cannot see the decision.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { loadConfig } from "../lib/config.mjs";
import { createRunRequest, decideRun, runStatus, sha256 } from "../lib/run-terminal.ts";
import { peerEnv } from "./helpers/env.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const SESSION = "0123456789abcdef";

function request() {
  const env = { ...peerEnv({ url: "http://127.0.0.1:9" }, { peer: "claude" }), AI_COLLAB_RUN_IN_TERMINAL: "1" };
  const cfg = loadConfig(env, { session: SESSION });
  const cwd = tempDir({ after }, "ai-collab-run-");
  const created = createRunRequest(cfg, { script: "echo hi\n", cwd, reason: "test" }, env);
  return { env, cfg, created };
}

test("a refusal that closes the card pushes an update", () => {
  const { env, cfg, created } = request();
  let updates = 0;
  assert.throws(() => decideRun({ stateDir: cfg.stateDir, project: cfg.project, id: created.id, decision: "run", sha256: sha256("other"), onUpdate: () => { updates += 1; }, env }), /hash does not match/);
  assert.equal(updates, 1);
  assert.equal(runStatus(cfg.stateDir, cfg.project, created.id).status, "refused");
});

test("a refusal that leaves the card as it was pushes nothing", () => {
  const { env, cfg, created } = request();
  let updates = 0;
  const decide = () => decideRun({ stateDir: cfg.stateDir, project: cfg.project, id: created.id, decision: "run", sha256: sha256("other"), onUpdate: () => { updates += 1; }, env });
  assert.throws(decide);
  assert.throws(decide, /already decided/);
  assert.equal(updates, 1);
});
