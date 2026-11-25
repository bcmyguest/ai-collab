import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../lib/config.mjs";
import { runCli } from "../lib/cli.mjs";
import { listTeams, createTeam, deleteTeam, teamStatus, teamStart, parseMember, readGlobalTeams, writeGlobalTeams, readProjectsFile, removeProject, setProjectClosed } from "../lib/teams.mjs";
import { recordSession } from "../lib/sessions.mjs";
import { sessionLabel } from "../lib/config.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

test("parseMember accepts harness and harness:model", () => {
  assert.equal(parseMember("claude"), "claude");
  assert.equal(parseMember("opencode:openai/gpt-5"), "opencode:openai/gpt-5");
  assert.equal(parseMember("mallory"), null);
});

test("project teams override global teams.json", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-teams-"));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };
  const root = path.join(home, "repo");
  mkdirSync(path.join(env.XDG_CONFIG_HOME, "ai-collab"), { recursive: true });
  mkdirSync(root);
  writeFileSync(path.join(env.XDG_CONFIG_HOME, "ai-collab", "projects.json"), JSON.stringify([
    { root, project: "demo", url: "http://127.0.0.1:9", peers: "claude,codex", teams: { local: ["claude"] } },
  ]));
  writeGlobalTeams(env, { local: ["codex"], global: ["cursor"] });
  const cfg = loadConfig({ ...env, AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "operator" });
  assert.deepEqual(listTeams(cfg, env), { local: ["claude"], global: ["cursor"] });
});

test("team CLI create, list, delete, start and status", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-team-cli-"));
  const bin = path.join(home, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "codex"), "#!/bin/sh\n");
  chmodSync(path.join(bin, "codex"), 0o755);
  const root = path.join(home, "repo");
  const stateDir = path.join(home, "state");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([
    { root, project: "demo", url: fake.url, peers: "claude,codex" },
  ]));
  const env = { ...peerEnv(fake, { peer: "operator", stateDir, AI_COLLAB_PEERS: "claude,codex", AI_COLLAB_PROJECT: "demo" }), HOME: home, PATH: bin + path.delimiter + process.env.PATH };
  const cfg = loadConfig(env);
  const starts = [];
  const cli = (argv) => runCli(argv, {
    env,
    stdout: { write() {} },
    stderr: { write() {} },
    async readStdin() { return ""; },
  });

  assert.equal(await cli(["team", "create", "light", "codex"]), 0);
  assert.deepEqual(listTeams(cfg, env).light, ["codex"]);
  assert.equal(await cli(["team", "list"]), 0);
  const started = await teamStart(cfg, "light", "codex", "fix tests", env, {
    start: async () => ({ status: "started", session: "codex#0123456789abcdef", detail: "ok" }),
  });
  assert.equal(started.session, "codex#0123456789abcdef");
  const codex = { ...loadConfig({ ...env, AI_COLLAB_PEER: "codex" }), session: sessionLabel("x1") };
  await recordSession(codex, { id: "x1", cwd: root, harness: "codex", event: "SessionStart" });
  await teamStart(cfg, "light", "codex", "again", env, { start: async () => ({ status: "started", session: codex.peer + "#" + codex.session, detail: "ok" }) });
  const row = teamStatus(cfg, "light", env).find((item) => item.member === "codex");
  assert.equal(row.address, `codex#${codex.session}`);
  assert.equal(row.online, false);
  assert.equal(await cli(["team", "delete", "light"]), 0);
  assert.equal(listTeams(cfg, env).light, undefined);
});

test("createTeam rejects unknown models", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-team-bad-"));
  const root = path.join(home, "repo");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([
    { root, project: "demo", url: "http://127.0.0.1:9", peers: "codex" },
  ]));
  const env = { HOME: home, AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "operator", AI_COLLAB_PEERS: "codex" };
  const cfg = loadConfig(env);
  await assert.rejects(createTeam(cfg, "bad", ["codex:unknown"], env, { codex: ["gpt-5"] }), /unknown model/);
});

test("projects.json writes wait for the projects.json lock", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-projects-"));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };
  const dir = path.join(env.XDG_CONFIG_HOME, "ai-collab");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "projects.json"), JSON.stringify(["alpha", "beta"].map((project) => ({ root: path.join(home, project), project }))));
  const held = path.join(dir, "projects.json.lock");
  mkdirSync(held);
  assert.throws(() => setProjectClosed(env, "alpha", true), /busy/, "a write does not bypass a held lock");
  rmdirSync(held);
  setProjectClosed(env, "alpha", true);
  removeProject(env, "beta");
  assert.deepEqual(readProjectsFile(env).map((entry) => [entry.project, entry.closed]), [["alpha", true]]);
});
