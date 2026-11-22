import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../lib/config.mjs";
import { advanceRun, runStatus, startRun } from "../lib/pattern-runs.mjs";
import { listPatterns } from "../lib/patterns.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const MODELS = { claude: ["claude-haiku-5-5"], codex: ["gpt-5"], cursor: ["deepseek-v41-flash-1017-high"] };

const FAN = `digraph fan {
  lead [agent="claude:claude-haiku-5-5", prompt="Lead."];
  workers [agent="codex", count=2, prompt="Work."];
  reviewers [agent="cursor", count=2, prompt="Review."];
  lead -> workers [on="dispatch", kind="broadcast", required=true];
  workers -> reviewers [on="submit", kind="pair", required=true];
  reviewers -> lead [on="pass", kind="fan-in", required=true];
  lead -> done [on="finished", kind="pair", required=true];
}
`;

const LOOP = `digraph loop {
  graph [max_visits=2];
  a [agent="claude", prompt="A."];
  b [agent="codex", prompt="B."];
  a -> b [on="go", kind="pair"];
  b -> a [on="back", kind="pair"];
  a -> done [on="finish", kind="pair"];
}
`;

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

// Each clock read moves time 60 s, so every start passes the project's 10 s gate.
function clock() {
  const state = { t: 1_000_000 };
  return () => (state.t += 60_000);
}

async function fixture(t, teams) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-team-runs-"));
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

test("count starts N instances, broadcast activates them all, and each instance gets its index", async (t) => {
  const { env, cfg } = await fixture(t, { fan: FAN });
  const { calls, start } = fakeStart();
  const now = clock();
  const { id } = await startRun(cfg, "fan", "ship it", env, { start, models: MODELS, now });
  assert.equal(calls.length, 1);
  const moved = await advanceRun(cfg, id, "dispatch", { caller: sessionOf(cfg, id, "lead"), env, start, now });
  assert.equal(moved.active, "workers");
  assert.equal(calls.length, 3, "two worker instances start");
  assert.match(calls[1].prompt, /Instance 1 of 2\./);
  assert.match(calls[2].prompt, /Instance 2 of 2\./);
  assert.deepEqual(runStatus(cfg, id).live, [{ role: "workers", index: 0 }, { role: "workers", index: 1 }]);
});

test("pair maps each worker to the reviewer with the same index; fan-in waits for every reviewer", async (t) => {
  const { env, cfg, fake } = await fixture(t, { fan: FAN });
  const { calls, start } = fakeStart();
  const now = clock();
  const { id } = await startRun(cfg, "fan", "ship it", env, { start, models: MODELS, now });
  await advanceRun(cfg, id, "dispatch", { caller: sessionOf(cfg, id, "lead"), env, start, now });

  await advanceRun(cfg, id, "submit", { caller: sessionOf(cfg, id, "workers", 1), env, start, now });
  assert.equal(calls.length, 4, "reviewer 2 starts, not reviewer 1");
  assert.match(calls[3].prompt, /Instance 2 of 2\./);
  assert.deepEqual(runStatus(cfg, id).live, [{ role: "workers", index: 0 }, { role: "reviewers", index: 1 }]);

  await advanceRun(cfg, id, "submit", { caller: sessionOf(cfg, id, "workers", 0), env, start, now });
  assert.equal(calls.length, 5);
  assert.match(calls[4].prompt, /Instance 1 of 2\./);

  const first = await advanceRun(cfg, id, "pass", { caller: sessionOf(cfg, id, "reviewers", 0), env, start, now });
  assert.equal(first.status, "running");
  assert.match(first.detail, /waiting for the other reviewers instances \(1 of 2 advanced\)/);
  assert.equal(runStatus(cfg, id).active, "reviewers", "lead is not activated yet");

  const sent = fake.state.publishes.length;
  const second = await advanceRun(cfg, id, "pass", { caller: sessionOf(cfg, id, "reviewers", 1), env, start, now });
  assert.equal(second.active, "lead");
  assert.equal(calls.length, 5, "lead already has a session, so it is messaged, not started");
  assert.ok(fake.state.publishes.length > sent, "lead is messaged");
  assert.deepEqual(runStatus(cfg, id).live, [{ role: "lead", index: 0 }]);
});

test("a finish waits for every live instance and needs the required handoffs", async (t) => {
  const { env, cfg } = await fixture(t, { fan: FAN });
  const { start } = fakeStart();
  const now = clock();
  const { id } = await startRun(cfg, "fan", "ship it", env, { start, models: MODELS, now });
  await advanceRun(cfg, id, "dispatch", { caller: sessionOf(cfg, id, "lead"), env, start, now });
  await advanceRun(cfg, id, "submit", { caller: sessionOf(cfg, id, "workers", 0), env, start, now });
  await advanceRun(cfg, id, "submit", { caller: sessionOf(cfg, id, "workers", 1), env, start, now });
  await advanceRun(cfg, id, "pass", { caller: sessionOf(cfg, id, "reviewers", 0), env, start, now });
  await advanceRun(cfg, id, "pass", { caller: sessionOf(cfg, id, "reviewers", 1), env, start, now });
  const done = await advanceRun(cfg, id, "finished", { caller: sessionOf(cfg, id, "lead"), env, start, now });
  assert.equal(done.status, "done");
  assert.equal(runStatus(cfg, id).handoffs.filter((h) => h.on === "submit").length, 2);
});

test("a caller that is not a live instance is refused, even with another instance of the same role", async (t) => {
  const { env, cfg } = await fixture(t, { fan: FAN });
  const { start } = fakeStart();
  const now = clock();
  const { id } = await startRun(cfg, "fan", "ship it", env, { start, models: MODELS, now });
  await advanceRun(cfg, id, "dispatch", { caller: sessionOf(cfg, id, "lead"), env, start, now });
  await advanceRun(cfg, id, "submit", { caller: sessionOf(cfg, id, "workers", 0), env, start, now });
  await assert.rejects(advanceRun(cfg, id, "submit", { caller: sessionOf(cfg, id, "workers", 0), env, start, now }), /only the active role "workers" can advance/);
});

test("max_visits fails the run when a role is visited past the limit", async (t) => {
  const { env, cfg } = await fixture(t, { loop: LOOP });
  const { start } = fakeStart();
  const now = clock();
  const { id } = await startRun(cfg, "loop", "loop", env, { start, models: MODELS, now });
  assert.equal(listPatterns(cfg, env).loop.maxVisits, 2);
  await advanceRun(cfg, id, "go", { caller: sessionOf(cfg, id, "a"), env, start, now });
  await advanceRun(cfg, id, "back", { caller: sessionOf(cfg, id, "b"), env, start, now });
  await advanceRun(cfg, id, "go", { caller: sessionOf(cfg, id, "a"), env, start, now });
  const over = await advanceRun(cfg, id, "back", { caller: sessionOf(cfg, id, "b"), env, start, now });
  assert.equal(over.status, "failed");
  assert.match(over.detail, /role "a" reached its max_visits of 2/);
});

const CHANGE = `digraph change {
  orch      [agent="claude:claude-haiku-5-5", prompt="Orchestrate."];
  workers   [agent="codex", count=2, prompt="Work."];
  reviewers [agent="cursor", count=2, prompt="Review."];
  orch -> workers [on="dispatch", kind="broadcast", required=false];
  workers -> reviewers [on="submit", kind="pair", required=false];
  reviewers -> workers [on="fail", kind="pair", required=false];
  reviewers -> orch [on="pass", kind="fan-in", required=false];
  workers -> orch [on="blocked", kind="fan-in", required=false];
  orch -> done [on="finished", kind="pair", required=false];
}
`;

test("two fan-in edges into one target: a wait nothing live can end fails the run instead of hanging", async (t) => {
  const { env, cfg } = await fixture(t, { change: CHANGE });
  const { start } = fakeStart();
  const now = clock();
  const { id } = await startRun(cfg, "change", "x", env, { start, models: MODELS, now });
  await advanceRun(cfg, id, "dispatch", { caller: sessionOf(cfg, id, "orch"), env, start, now });
  await advanceRun(cfg, id, "blocked", { caller: sessionOf(cfg, id, "workers", 1), env, start, now });
  await advanceRun(cfg, id, "submit", { caller: sessionOf(cfg, id, "workers", 0), env, start, now });
  const stalled = await advanceRun(cfg, id, "pass", { caller: sessionOf(cfg, id, "reviewers", 0), env, start, now });
  assert.equal(stalled.status, "failed");
  assert.match(runStatus(cfg, id).error, /fan-in into "orch" stalled: no live instance can advance "pass" \(1 of 2 reviewers instances arrived\)/);
});

test("a role's skill is named in its start brief", async (t) => {
  const skilled = `digraph sk {
  a [agent="claude", skill="diagnose-failure", prompt="A."];
  b [agent="codex", prompt="B."];
  a -> b [on="go"];
  b -> done [on="finish"];
}
`;
  const { env, cfg } = await fixture(t, { sk: skilled });
  const { calls, start } = fakeStart();
  await startRun(cfg, "sk", "go", env, { start, models: MODELS, now: clock() });
  assert.match(calls[0].prompt, /Use the diagnose-failure skill\./);
});

test("max_visits counts each instance: N=3 with one fail-and-resubmit round stays within 3", async (t) => {
  const round = `digraph round {
  graph [max_visits=3];
  orch [agent="claude", prompt="O."];
  workers [agent="codex", count=3, prompt="W."];
  reviewers [agent="cursor", count=3, prompt="R."];
  orch -> workers [on="dispatch", kind="broadcast", required=false];
  workers -> reviewers [on="submit", kind="pair", required=false];
  reviewers -> workers [on="fail", kind="pair", required=false, cap=3];
  reviewers -> orch [on="pass", kind="fan-in", required=false];
  orch -> done [on="finished", kind="pair", required=false];
}
`;
  const { env, cfg } = await fixture(t, { round });
  const { start } = fakeStart();
  const now = clock();
  const { id } = await startRun(cfg, "round", "x", env, { start, models: MODELS, now });
  const at = (role, index) => sessionOf(cfg, id, role, index);
  await advanceRun(cfg, id, "dispatch", { caller: at("orch", 0), env, start, now });
  for (let i = 0; i < 3; i += 1) await advanceRun(cfg, id, "submit", { caller: at("workers", i), env, start, now });
  for (let i = 0; i < 3; i += 1) await advanceRun(cfg, id, "fail", { caller: at("reviewers", i), env, start, now });
  for (let i = 0; i < 3; i += 1) await advanceRun(cfg, id, "submit", { caller: at("workers", i), env, start, now });
  for (let i = 0; i < 2; i += 1) await advanceRun(cfg, id, "pass", { caller: at("reviewers", i), env, start, now });
  const last = await advanceRun(cfg, id, "pass", { caller: at("reviewers", 2), env, start, now });
  assert.equal(last.status, "running", "no visit limit is hit");
  const done = await advanceRun(cfg, id, "finished", { caller: at("orch", 0), env, start, now });
  assert.equal(done.status, "done");
});

test("a role's fallback goes into its start brief as an instruction not to switch itself", async (t) => {
  const withFallback = `digraph fb {
  a [agent="claude", prompt="A.", fallback="codex:gpt-5"];
  b [agent="codex", prompt="B."];
  a -> b [on="go"];
  b -> done [on="finish"];
}
`;
  const { env, cfg } = await fixture(t, { fb: withFallback });
  const { calls, start } = fakeStart();
  await startRun(cfg, "fb", "go", env, { start, models: MODELS, now: clock() });
  assert.match(calls[0].prompt, /If you hit a usage or subscription limit, tell the operator and propose switching to codex:gpt-5; do not switch yourself\./);
});

test("a pair edge between roles with different counts is an invalid team", async (t) => {
  const bad = `digraph bad {
  a [agent="claude", count=2, prompt="A."];
  b [agent="codex", count=3, prompt="B."];
  a -> b [on="go", kind="pair"];
  b -> done [on="finish"];
}
`;
  const { env, cfg } = await fixture(t, { bad });
  assert.match(listPatterns(cfg, env).bad.invalid, /pair edge "a" -> "b" needs both roles to have the same count/);
});
