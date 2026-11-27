import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { DotError, parseDot, serializeDot } from "../lib/catalog/dot.ts";
import { patternFromTeam, teamFromPattern, validatePattern, withExtras } from "../lib/catalog/pattern-model.ts";
import { loadConfig } from "../lib/config.ts";
import { startRun } from "../lib/pattern-runs.ts";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const MODELS = { claude: ["claude-haiku-5-5"], codex: ["gpt-5"] };
const TEAM = `digraph "duo" {
  "lead" [agent="codex", prompt="Scope it."];
  "doer" [agent="claude", prompt="Do it."];
  "lead" -> "doer" [on="scope"];
  "doer" -> "done" [on="finished"];
}`;
const withLanding = (value) => TEAM.replace('digraph "duo" {', `digraph "duo" {\n  graph [landing="${value}"];`);

test("the team.dot landing attribute parses and round-trips through serializeDot", () => {
  for (const value of ["pr", "packet", "branch"]) {
    const team = parseDot(withLanding(value));
    assert.equal(team.landing, value);
    assert.match(serializeDot(team), new RegExp(`graph \\[landing="${value}"\\]`));
    assert.equal(parseDot(serializeDot(team)).landing, value);
  }
  assert.equal("landing" in parseDot(TEAM), false, "a team without the attribute keeps the default");
});

test("an unknown landing policy is refused with the valid values and the line", () => {
  assert.throws(() => parseDot(withLanding("main")), (error) => error instanceof DotError
    && /landing must be one of pr, packet, branch; got "main"/.test(error.message) && error.line === 2);
});

test("the pattern carries the landing policy and gives it back to team.dot", () => {
  const team = parseDot(withLanding("packet"));
  const pattern = withExtras(validatePattern(patternFromTeam(team)), team);
  assert.equal(pattern.landing, "packet");
  assert.equal(teamFromPattern(pattern).landing, "packet");
  const plain = parseDot(TEAM);
  assert.equal("landing" in withExtras(validatePattern(patternFromTeam(plain)), plain), false);
});

async function fixture(t, teams) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = tempDir({ after }, "ai-collab-team-landing-");
  const root = path.join(home, "repo");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  for (const [name, text] of Object.entries(teams)) {
    mkdirSync(path.join(root, ".ai-collab", "teams", name), { recursive: true });
    writeFileSync(path.join(root, ".ai-collab", "teams", name, "team.dot"), text);
  }
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo", url: fake.url, peers: "claude,codex" }]));
  const env = { ...peerEnv(fake, { peer: "operator", stateDir: path.join(home, "state"), AI_COLLAB_PEERS: "claude,codex", AI_COLLAB_PROJECT: "demo" }), HOME: home };
  return { env, cfg: loadConfig(env) };
}

function fakeStart() {
  const calls = [];
  const start = async (_cfg, options) => {
    calls.push(options);
    return { status: "started", session: `${options.harness}#${String(calls.length).padStart(16, "0")}`, detail: "ok" };
  };
  return { calls, start };
}

test("a role brief tells the member how to finish branch work under the team's landing policy", async (t) => {
  const { env, cfg } = await fixture(t, { duo: TEAM, packet: withLanding("packet").replace('"duo"', '"packet"') });
  let clock = 1_000_000;
  const now = () => (clock += 60_000);
  const plain = fakeStart();
  await startRun(cfg, "duo", "ship it", env, { start: plain.start, models: MODELS, now });
  assert.match(plain.calls[0].prompt, /ai-collab land finish <branch> --proof <file>$/m);
  const packet = fakeStart();
  await startRun(cfg, "packet", "ship it", env, { start: packet.start, models: MODELS, now });
  assert.match(packet.calls[0].prompt, /ai-collab land finish <branch> --proof <file> --landing packet$/m);
});
