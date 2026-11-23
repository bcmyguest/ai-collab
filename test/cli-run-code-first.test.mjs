// defaults.json "readsThroughRunCode": CLI read commands from an agent session exit 3 with the run_code program to run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../lib/cli.mjs";

const CLI = fileURLToPath(new URL("../scripts/ai-collab.mjs", import.meta.url));

function setupEnv({ setting = true, openshell = true, extra = {} } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "ai-collab-crcf-"));
  const config = path.join(home, ".config");
  mkdirSync(path.join(config, "ai-collab"), { recursive: true });
  writeFileSync(path.join(config, "ai-collab", "defaults.json"), JSON.stringify(setting === null ? {} : { readsThroughRunCode: setting }));
  const bin = path.join(home, "bin");
  mkdirSync(bin);
  if (openshell) { writeFileSync(path.join(bin, "openshell"), "#!/bin/sh\nexit 0\n"); chmodSync(path.join(bin, "openshell"), 0o755); }
  return {
    HOME: home, XDG_CONFIG_HOME: config, PATH: `${bin}:${path.dirname(process.execPath)}`,
    AI_COLLAB_URL: "http://127.0.0.1:9", AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "alice", AI_COLLAB_PEERS: "alice,bob",
    AI_COLLAB_STATE_DIR: path.join(home, "state"), AI_COLLAB_TIMEOUT_MS: "500", XDG_DATA_HOME: path.join(home, "data"),
    ...extra,
  };
}

async function cli(argv, env, agent) {
  let out = "";
  let err = "";
  const code = await runCli(argv, { env, agent, stdout: { write: (s) => { out += s; return true; } }, stderr: { write: (s) => { err += s; return true; } } });
  return { code, out, err };
}

const READS = [
  [["task", "list", "open"], /ai\.task_list\(\{"status":"open"\}\)/],
  // An agent's guessed --status flag still yields a valid program.
  [["task", "list", "--status", "open"], /ai\.task_list\(\{"status":"open"\}\)/],
  [["task", "show", "fix-x"], /ai\.task_list\(.*"fix-x"/],
  [["agents", "--all"], /ai\.list_agents\(\{"all":true\}\)/],
  [["sessions"], /ai\.list_sessions\(/],
  [["history", "--limit", "5"], /ai\.channel_history\(\{"limit":5\}\)/],
  [["peers"], /ai\.list_agents\(/],
  [["team", "status", "core"], /ai\.team_status\(\{"name":"core"\}\)/],
  [["pattern", "list"], /ai\.pattern_list\(/],
  [["pattern", "status", "abc123"], /ai\.pattern_status\(\{"run":"abc123"\}\)/],
];

test("an agent session's CLI reads exit 3 with the run_code program on stderr", async () => {
  const env = setupEnv({ extra: { AI_COLLAB_SESSION: "0123456789abcdef" } });
  for (const [argv, program] of READS) {
    const result = await cli(argv, env);
    assert.equal(result.code, 3, argv.join(" "));
    assert.equal(result.out, "", argv.join(" "));
    assert.match(result.err, /run_code/, argv.join(" "));
    assert.match(result.err, program, argv.join(" "));
  }
});

test("a harness parent counts as an agent session", async () => {
  const result = await cli(["task", "list"], setupEnv(), true);
  assert.equal(result.code, 3);
  assert.match(result.err, /ai\.task_list\(\{\}\)/);
});

test("a human terminal, AI_COLLAB_DIRECT_READS=1, a missing setting or missing OpenShell keep CLI reads direct", async () => {
  const cases = [
    [setupEnv(), false],
    [setupEnv({ extra: { AI_COLLAB_SESSION: "0123456789abcdef", AI_COLLAB_DIRECT_READS: "1" } }), true],
    [setupEnv({ setting: null }), true],
    [setupEnv({ openshell: false }), true],
  ];
  for (const [env, agent] of cases) {
    const result = await cli(["task", "list"], env, agent);
    assert.equal(result.code, 0, result.err);
    assert.doesNotMatch(result.err, /run_code/);
  }
});

test("writes and help stay direct for agents", async () => {
  const env = setupEnv();
  assert.doesNotMatch((await cli(["task", "list", "--help"], env, true)).err, /run_code/);
  const added = await cli(["task", "add", "a title"], env, true);
  assert.equal(added.code, 0, added.err);
});

test("the CLI detects a harness parent process", { timeout: 10000 }, () => {
  const env = setupEnv();
  // A parent whose argv[0] is "claude" stands in for Claude Code running the Bash tool.
  const parent = `const r = require("node:child_process").spawnSync(process.execPath, [${JSON.stringify(CLI)}, "task", "list"], { encoding: "utf8" });`
    + "process.stderr.write(r.stderr); process.exitCode = r.status;";
  const result = spawnSync(process.execPath, ["-e", parent], { env, encoding: "utf8", argv0: "claude" });
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /run_code/);
});
