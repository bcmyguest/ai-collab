import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { parseDot } from "../lib/catalog/dot.ts";
import { patternFromTeam, validatePattern, withExtras } from "../lib/catalog/pattern-model.ts";
import { runCli } from "../lib/cli.ts";
import { loadConfig, sessionLabel } from "../lib/config.ts";
import { launchPatternRun, preparePatternRun } from "../lib/pattern-runs.ts";
import { slashCommand } from "../lib/slash.ts";
import { createFakeAdapter } from "../runner/adapters/fake.ts";
import { openDurable } from "../lib/durable.ts";
import { createRunner } from "../runner/runner.ts";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { fileEnd, tempDir } from "./helpers/tmp.mjs";

const UUID = "6f1d2c3a-4b5e-4f60-8a7b-9c0d1e2f3a4b";
const TEAM = `digraph "duo" {
  graph [permission="default"];
  "lead" [agent="codex", prompt="Scope it."];
  "lead" -> "done" [on="finished"];
}`;

// A booted runner over fake claude, codex and cursor adapters; the cursor fake offers no auto, like the real one.
async function bootRunner(extraEnv = {}) {
  const fake = await startFakeNtfy();
  const home = tempDir(fileEnd, "pm-defaults-");
  const root = path.join(home, "demo");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), AI_COLLAB_URL: fake.url,
    AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "runner", AI_COLLAB_PEERS: "codex,claude,cursor,operator,runner",
    AI_COLLAB_STATE_DIR: path.join(home, "state"), AI_COLLAB_TIMEOUT_MS: "2000", ...extraEnv,
  };
  const adapters = new Map([
    ["claude", createFakeAdapter({ harness: "claude" })],
    ["codex", createFakeAdapter({ harness: "codex" })],
    ["cursor", createFakeAdapter({ harness: "cursor", capabilities: { permissionModes: ["supervised", "full-access"] } })],
  ]);
  const runner = createRunner({ projects: [loadConfig(env, { cwd: root })], adapters, durable: openDurable(":memory:"), env, startGapMs: 0, watch: false });
  await runner.boot();
  after(async () => { await runner.stop(); await fake.close(); });
  return runner;
}

const modeOf = async (runner, input) => runner.get((await runner.start({ project: "demo", prompt: "hi", ...input })).session).permissionMode;

test("an operator start runs supervised on every harness", async () => {
  const runner = await bootRunner();
  assert.equal(await modeOf(runner, { harness: "codex" }), "supervised");
  assert.equal(await modeOf(runner, { harness: "claude" }), "supervised");
  assert.equal(await modeOf(runner, { harness: "cursor" }), "supervised");
});

test("a team member start runs auto where the harness offers it", async () => {
  const runner = await bootRunner();
  assert.equal(await modeOf(runner, { harness: "codex", managed: true }), "auto");
  assert.equal(await modeOf(runner, { harness: "claude", managed: true }), "auto");
  assert.equal(await modeOf(runner, { harness: "cursor", managed: true }), "supervised");
});

test("a team.dot permission attribute reaches every role start and sets a Codex member's mode", async () => {
  const team = parseDot(TEAM);
  const pattern = withExtras(validatePattern(patternFromTeam(team)), team);
  const cfg = { project: "demo", stateDir: tempDir({ after }, "pm-dot-"), peers: [] };
  const run = await preparePatternRun(cfg, pattern, "Ship it", {}, { models: {} });
  assert.equal(run.definition.permission, "default");
  const starts = [];
  await launchPatternRun(cfg, run, {}, async (_cfg, options) => { starts.push(options); return { status: "started", session: "codex#0000000000000001" }; });
  assert.equal(starts[0].claudePermission, "default");
  const runner = await bootRunner();
  assert.equal(await modeOf(runner, { harness: "codex", managed: true, claudePermission: "default" }), "supervised");
  assert.equal(await modeOf(runner, { harness: "cursor", managed: true, claudePermission: "auto" }), "supervised", "a mode the harness lacks falls back to its default");
});

test("an instance setting replaces both defaults", async () => {
  const runner = await bootRunner();
  assert.equal(await modeOf(runner, { harness: "codex", permissionMode: "auto" }), "auto");
  assert.equal(await modeOf(runner, { harness: "codex", managed: true, permissionMode: "accept-edits" }), "accept-edits");
  assert.equal(await modeOf(runner, { harness: "codex", claudePermission: "acceptEdits" }), "accept-edits");
  assert.equal(await modeOf(runner, { harness: "claude", claudePermission: "auto" }), "auto");
});

test("/mode changes a live session's mode through the runner and takes the Claude names", async () => {
  const runner = await bootRunner();
  const { session } = await runner.start({ project: "demo", harness: "codex", prompt: "hi", managed: true });
  assert.deepEqual(await runner.setMode(session, "default"), { status: "changed", permissionMode: "supervised" });
  const peer = { id: `claude#${sessionLabel(UUID)}`, harness: "claude", sessionId: UUID, cwd: os.tmpdir() };
  const asked = [];
  const changed = await slashCommand(peer, { name: "mode", args: "acceptEdits" }, { setMode: async (p, mode) => { asked.push([p.id, mode]); return { permissionMode: "accept-edits" }; } });
  assert.deepEqual(changed, { status: "succeeded", detail: "Permission mode is now accept-edits." });
  assert.deepEqual(asked, [[peer.id, "acceptEdits"]]);
  const refused = await slashCommand(peer, { name: "mode", args: "auto" }, { setMode: async () => { throw new Error("no such session"); } });
  assert.deepEqual(refused, { status: "failed", detail: "no such session" });
  assert.equal((await slashCommand(peer, { name: "mode", args: "" }, { setMode: async () => ({}) })).status, "failed");
  const cursor = await slashCommand({ ...peer, harness: "cursor" }, { name: "mode", args: "auto" }, { setMode: async () => ({}) });
  assert.equal(cursor.status, "unsupported");
});

test("ai-collab mode posts to the runner's mode route and prints the new mode", async () => {
  const socket = path.join(tempDir({ after }, "pm-sock-"), "runner.sock");
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push([req.method, req.url, JSON.parse(body)]);
      const refused = JSON.parse(body).mode === "full-access";
      res.writeHead(refused ? 400 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(refused ? { error: "full-access runs only in openshell" } : { status: "changed", permissionMode: "auto" }));
    });
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  after(() => new Promise((resolve) => server.close(resolve)));
  const io = (agent = false) => { const out = []; const err = []; return { out, err, agent, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, env: { AI_COLLAB_RUNNER_SOCKET: socket } }; };
  const ok = io();
  assert.equal(await runCli(["mode", "codex#00000000000000aa", "auto"], ok), 0);
  assert.deepEqual(ok.out, ["codex#00000000000000aa\tauto\n"]);
  assert.deepEqual(seen[0], ["POST", "/v1/sessions/codex/00000000000000aa/mode", { mode: "auto" }]);
  const bad = io();
  assert.equal(await runCli(["mode", "codex#00000000000000aa", "full-access"], bad), 1);
  assert.deepEqual(bad.err, ["ai-collab: mode: full-access runs only in openshell\n"]);
  const usage = io();
  assert.equal(await runCli(["mode", "codex#00000000000000aa"], usage), 1);
  assert.match(usage.err.join(""), /usage: mode <peer#session> <mode>/);
  const agent = io(true);
  assert.equal(await runCli(["mode", "codex#00000000000000aa", "auto"], agent), 1);
  assert.match(agent.err.join(""), /only the operator changes a permission mode/);
  assert.equal(seen.length, 2, "an agent's request never reaches the runner");
});

test("full access stays refused on the host for a member start and for a mode change by Claude name", async () => {
  const runner = await bootRunner();
  await assert.rejects(runner.start({ project: "demo", harness: "codex", prompt: "hi", managed: true, claudePermission: "bypassPermissions" }), /full-access runs only in openshell/);
  const { session } = await runner.start({ project: "demo", harness: "codex", prompt: "hi", managed: true });
  await assert.rejects(runner.setMode(session, "bypassPermissions"), /full-access runs only in openshell/);
  await assert.rejects(runner.setMode(session, "full-access"), /full-access runs only in openshell/);
});
