import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../lib/config.mjs";
import { advanceRun, listRuns, runStatus, startRun } from "../lib/pattern-runs.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

function fakeStart() {
  const calls = [];
  let n = 0;
  const start = async (_cfg, options) => {
    calls.push(options);
    n += 1;
    return { status: "started", session: `${options.harness}#${n.toString(16).padStart(16, "0")}`, detail: "ok" };
  };
  return { calls, start };
}

async function fixture(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-pattern-runs-"));
  const root = path.join(home, "repo");
  const stateDir = path.join(home, "state");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([
    { root, project: "demo", url: fake.url, peers: "claude,codex,cursor" },
  ]));
  const env = { ...peerEnv(fake, { peer: "operator", stateDir, AI_COLLAB_PEERS: "claude,codex,cursor", AI_COLLAB_PROJECT: "demo" }), HOME: home };
  return { fake, env, cfg: loadConfig(env) };
}

test("fix-and-review runs in order, loops on changes requested, and finishes only after approval", async (t) => {
  const { env, cfg } = await fixture(t);
  const { calls, start } = fakeStart();
  const models = { claude: ["claude-haiku-5-5"], codex: ["gpt-5"], cursor: ["deepseek-v41-flash-1017-high"] };
  const started = await startRun(cfg, "fix-and-review", "add retry to fetch", env, { start, models });
  assert.equal(started.status, "running");
  assert.equal(started.active, "lead");
  assert.equal(calls[0].harness, "claude");
  assert.match(calls[0].prompt, /Pattern "fix-and-review".*role "lead"/s);
  const id = started.id;

  const scoped = await advanceRun(cfg, id, "scope", { note: "one function", env, start });
  assert.equal(scoped.active, "implementer");
  assert.equal(calls.length, 2, "implementer had no session, so one starts");
  assert.match(calls[1].prompt, /Note: one function/);

  // Finishing before the required review fired is refused.
  await assert.rejects(advanceRun(cfg, id, "finished", { env, start }), /no handoff "finished" from implementer/);

  await advanceRun(cfg, id, "diff and test results", { env, start });
  assert.equal(calls.length, 3, "reviewer starts");

  for (let round = 1; round <= 3; round += 1) {
    const back = await advanceRun(cfg, id, "changes requested", { env, start });
    assert.equal(back.active, "implementer");
    assert.equal(back.status, "running");
    await advanceRun(cfg, id, "diff and test results", { env, start });
  }
  const capped = await advanceRun(cfg, id, "changes requested", { env, start });
  assert.equal(capped.status, "failed");
  assert.match(capped.detail, /cap of 3/);
  assert.equal(runStatus(cfg, id).status, "failed");
});

test("completion is refused until the required approval has fired", async (t) => {
  const { env, cfg } = await fixture(t);
  const { start } = fakeStart();
  const { id } = await startRun(cfg, "fix-and-review", "fix it", env, { start, models: { claude: ["claude-haiku-5-5"], codex: ["gpt-5"], cursor: ["deepseek-v41-flash-1017-high"] } });
  await advanceRun(cfg, id, "scope", { env, start });
  await advanceRun(cfg, id, "diff and test results", { env, start });
  await assert.rejects(advanceRun(cfg, id, "finished", { env, start }), /no handoff "finished" from reviewer/);
  const approved = await advanceRun(cfg, id, "approved", { env, start });
  assert.equal(approved.active, "lead");
  const done = await advanceRun(cfg, id, "finished", { env, start });
  assert.equal(done.status, "done");
  const run = runStatus(cfg, id);
  assert.deepEqual(run.handoffs.map((h) => `${h.from}>${h.to}:${h.on}`), [
    "lead>implementer:scope", "implementer>reviewer:diff and test results", "reviewer>lead:approved", "lead>done:finished",
  ]);
  await assert.rejects(advanceRun(cfg, id, "scope", { env, start }), /is done/);
});

test("a finish with a required handoff missing names the handoff", async (t) => {
  const { env, cfg } = await fixture(t);
  const { start } = fakeStart();
  const pattern = {
    name: "strict",
    roles: [{ id: "lead", responsibility: "Lead.", harness: "claude" }, { id: "doer", responsibility: "Do.", harness: "codex" }],
    handoffs: [
      { from: "lead", to: "doer", on: "go", required: true },
      { from: "doer", to: "lead", on: "back", required: false },
      { from: "lead", to: "done", on: "finished", required: false },
    ],
  };
  const file = path.join(env.HOME, ".config", "ai-collab", "projects.json");
  const projects = JSON.parse(readFileSync(file, "utf8"));
  projects[0].patterns = { strict: pattern };
  writeFileSync(file, JSON.stringify(projects));
  const { id } = await startRun(cfg, "strict", "x", env, { start, models: {} });
  await assert.rejects(advanceRun(cfg, id, "finished", { env, start }), /required handoff not done: "go" lead -> doer/);
  assert.equal(runStatus(cfg, id).status, "running");
  assert.equal(listRuns(cfg)[0].id, id);
});

test("advance rejects unknown runs and bad ids", async (t) => {
  const { env, cfg } = await fixture(t);
  await assert.rejects(advanceRun(cfg, "abcdef1234", "scope", { env }), /unknown run/);
  await assert.rejects(advanceRun(cfg, "../etc", "scope", { env }), /invalid run id/);
});
