// A fan-in that can never complete fails the run even while another role is still live; a fan-in that can still complete keeps waiting.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { loadConfig } from "../lib/config.ts";
import { advanceRun, runStatus, startRun } from "../lib/pattern-runs.ts";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const MODELS = { claude: ["claude-haiku-5-5"], codex: ["gpt-5"], cursor: ["deepseek-v41-flash-1017-high"] };

// Worker 1 hands off to the sidecar instead of a reviewer, so reviewer 1 can never start; the sidecar keeps the run live, which
// is the case the old "no live instance at all" check missed.
const STALL = `digraph stall {
  orch      [agent="claude:claude-haiku-5-5", prompt="Orchestrate."];
  workers   [agent="codex", count=2, prompt="Work."];
  reviewers [agent="cursor", count=2, prompt="Review."];
  sidecar   [agent="codex", count=2, prompt="Watch."];
  orch      -> workers   [on="dispatch", kind="broadcast"];
  workers   -> reviewers [on="submit", kind="pair"];
  workers   -> sidecar   [on="flag", kind="pair"];
  sidecar   -> done      [on="finished", kind="pair"];
  reviewers -> orch      [on="pass", kind="fan-in"];
}
`;

// Both workers hand off, so reviewer 1 is still reachable while reviewer 0 waits: the fan-in must keep waiting.
const STILL = `digraph still {
  orch      [agent="claude:claude-haiku-5-5", prompt="Orchestrate."];
  workers   [agent="codex", count=2, prompt="Work."];
  reviewers [agent="cursor", count=2, prompt="Review."];
  orch      -> workers   [on="dispatch", kind="broadcast"];
  workers   -> reviewers [on="submit", kind="pair"];
  reviewers -> orch      [on="pass", kind="fan-in"];
  orch      -> done      [on="finished", kind="pair"];
}
`;

function fakeStart() {
  let n = 0;
  const start = async (_cfg, options) => {
    n += 1;
    return { status: "started", session: `${options.harness}#${n.toString(16).padStart(16, "0")}`, detail: "ok" };
  };
  return start;
}

const clock = () => {
  const state = { t: 1_000_000 };
  return () => (state.t += 60_000);
};

async function fixture(t, teams) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = tempDir({ after }, "ai-collab-fan-in-");
  const root = path.join(home, "repo");
  const stateDir = path.join(home, "state");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  for (const [name, text] of Object.entries(teams)) {
    mkdirSync(path.join(root, ".ai-collab", "teams", name), { recursive: true });
    writeFileSync(path.join(root, ".ai-collab", "teams", name, "team.dot"), text);
  }
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo", url: fake.url, peers: "claude,codex,cursor" }]));
  const env = { ...peerEnv(fake, { peer: "operator", stateDir, AI_COLLAB_PEERS: "claude,codex,cursor", AI_COLLAB_PROJECT: "demo" }), HOME: home };
  return { fake, env, cfg: loadConfig(env) };
}

const sessionOf = (cfg, id, role, index = 0) => runStatus(cfg, id).instances[role][index];

test("a fan-in whose remaining source instance can never run again fails the run while another role is live", async (t) => {
  const { env, cfg, fake } = await fixture(t, { stall: STALL });
  const start = fakeStart();
  const now = clock();
  const { id } = await startRun(cfg, "stall", "ship it", env, { start, models: MODELS, now });
  await advanceRun(cfg, id, "dispatch", { caller: sessionOf(cfg, id, "orch"), env, start, now });
  // Worker 1 flags the sidecar instead of handing to reviewer 1, so reviewer 1 can never be activated.
  await advanceRun(cfg, id, "flag", { caller: sessionOf(cfg, id, "workers", 1), env, start, now });
  await advanceRun(cfg, id, "submit", { caller: sessionOf(cfg, id, "workers", 0), env, start, now });
  assert.deepEqual(runStatus(cfg, id).live, [{ role: "sidecar", index: 1 }, { role: "reviewers", index: 0 }], "another role is still live");
  const stalled = await advanceRun(cfg, id, "pass", { caller: sessionOf(cfg, id, "reviewers", 0), env, start, now });
  assert.equal(stalled.status, "failed");
  assert.match(stalled.detail, /fan-in into "orch" stalled: no live instance can advance "pass" \(1 of 2 reviewers instances arrived\)/);
  assert.equal(runStatus(cfg, id).status, "failed");
  assert.ok(fake.state.publishes.some((p) => /Pattern run .* failed/.test(p.message)), "the operator hears about the stall");
});

test("a fan-in keeps waiting while another live instance can still activate the missing one", async (t) => {
  const { env, cfg } = await fixture(t, { still: STILL });
  const start = fakeStart();
  const now = clock();
  const { id } = await startRun(cfg, "still", "ship it", env, { start, models: MODELS, now });
  await advanceRun(cfg, id, "dispatch", { caller: sessionOf(cfg, id, "orch"), env, start, now });
  await advanceRun(cfg, id, "submit", { caller: sessionOf(cfg, id, "workers", 0), env, start, now });
  // Reviewer 0 passes while worker 1 is still live and can start reviewer 1.
  const waiting = await advanceRun(cfg, id, "pass", { caller: sessionOf(cfg, id, "reviewers", 0), env, start, now });
  assert.equal(waiting.status, "running");
  assert.match(waiting.detail, /waiting for the other reviewers instances \(1 of 2 advanced\)/);
  await advanceRun(cfg, id, "submit", { caller: sessionOf(cfg, id, "workers", 1), env, start, now });
  const moved = await advanceRun(cfg, id, "pass", { caller: sessionOf(cfg, id, "reviewers", 1), env, start, now });
  assert.equal(moved.status, "running");
  assert.equal(moved.active, "orch");
  assert.equal(runStatus(cfg, id).status, "running");
});
