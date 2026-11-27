import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { test, after } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.ts";
import { createPattern, getPattern, listPatterns } from "../lib/patterns.mjs";
import { createTeam } from "../lib/teams.mjs";
import { startRun } from "../lib/pattern-runs.ts";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const MODELS = { claude: ["claude-haiku-5-5"], codex: ["gpt-5"], cursor: ["deepseek-v41-flash-1017-high"] };

function project(extra = {}) {
  const home = tempDir({ after }, "ai-collab-pattern-guards-");
  const root = path.join(home, "repo");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  const file = path.join(home, ".config", "ai-collab", "projects.json");
  writeFileSync(file, JSON.stringify([{ root, project: "demo", url: "http://127.0.0.1:9", peers: "claude,codex,cursor", ...extra }]));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "operator", AI_COLLAB_PEERS: "claude,codex,cursor", AI_COLLAB_URL: "http://127.0.0.1:9" };
  return { env, cfg: loadConfig(env), file, home };
}

const pair = (name = "pair") => ({
  name,
  roles: [
    { id: "lead", responsibility: "Scope it.", harness: "claude" },
    { id: "doer", responsibility: "Do it.", harness: "codex" },
  ],
  handoffs: [
    { from: "lead", to: "doer", on: "scope", required: false },
    { from: "doer", to: "done", on: "finished", required: true },
  ],
});

test("a saved pattern that no longer validates is listed as invalid and cannot start", async () => {
  const { env, cfg, file } = project();
  const projects = JSON.parse(readFileSync(file, "utf8"));
  projects[0].patterns = { broken: { roles: [{ id: "lead", responsibility: "a", harness: "claude" }], handoffs: [] } };
  writeFileSync(file, JSON.stringify(projects));
  const listed = listPatterns(cfg, env).broken;
  assert.equal(listed.source, "project");
  assert.match(listed.invalid, /at least one handoff/);
  assert.throws(() => getPattern(cfg, "broken", env), /is invalid/);
  await assert.rejects(startRun(cfg, "broken", "x", env, { start: async () => ({ status: "started" }), models: MODELS }), /is invalid/);
});

test("reserved names refuse harnesses, peers, operator and all", async () => {
  const { env, cfg } = project();
  await assert.rejects(createPattern(cfg, pair("claude"), env, MODELS), /reserved/);
  await assert.rejects(createPattern(cfg, pair("cursor"), env, MODELS), /reserved/);
  await assert.rejects(createPattern(cfg, pair("operator"), env, MODELS), /reserved/);
  await assert.rejects(createPattern(cfg, pair("done"), env, MODELS), /reserved/);
});

test("team and pattern names collide in both directions", async () => {
  const { env, cfg } = project();
  await createPattern(cfg, pair("crew-plan"), env, MODELS);
  await assert.rejects(createTeam(cfg, "crew-plan", ["codex"], env, MODELS), /pattern name/);
  await assert.rejects(createTeam(cfg, "fix-and-review", ["codex"], env, MODELS), /pattern name/);
  await createTeam(cfg, "crew", ["codex"], env, MODELS);
  await assert.rejects(createPattern(cfg, pair("crew"), env, MODELS), /team name/);
});

test("the start gate lets one run start per 10 seconds per project", async () => {
  const { env, cfg } = project();
  const start = async (_c, options) => ({ status: "started", session: `${options.harness}#0123456789abcdef`, detail: "ok" });
  const at = 5_000_000;
  await startRun(cfg, "fix-and-review", "one", env, { start, models: MODELS, now: () => at });
  await assert.rejects(startRun(cfg, "fix-and-review", "two", env, { start, models: MODELS, now: () => at + 9_000 }), /wait 10 seconds/);
  await startRun(cfg, "fix-and-review", "three", env, { start, models: MODELS, now: () => at + 10_000 });
});

test("MCP pattern_start refuses agent callers", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const { env: base } = project();
  const env = peerEnv(fake, { peer: "claude", stateDir: path.join(base.HOME, "state"), AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEERS: "claude,codex,cursor" });
  const script = fileURLToPath(new URL("../scripts/ai-collab-mcp.mjs", import.meta.url));
  const child = spawn(process.execPath, [script, "claude"], { env: { ...env, HOME: base.HOME }, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => child.kill());
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pattern_start", arguments: { name: "fix-and-review", task: "x", session: "0123456789abcdef" } } })}\n`);
  const response = JSON.parse((await output.next()).value).result;
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /operator-only/);
});
