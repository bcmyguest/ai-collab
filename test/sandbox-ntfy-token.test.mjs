// A Cursor OpenShell session and every builder sandbox must carry the ntfy token. Claude already did.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../lib/cli.mjs";
import { builderSandbox } from "../lib/builder.mjs";
import { prepareSandbox, sandboxName } from "../runner/adapters/cursor.mjs";
import { ensureSandbox } from "../runner/sandbox.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPENSHELL = path.join(HERE, "helpers", "fake-openshell.mjs");
const SYSTEMD = path.join(HERE, "helpers", "fake-systemd-run.mjs");
const AGENT = path.join(HERE, "helpers", "fake-builder-agent.mjs");
const CLAUDE = path.join(HERE, "helpers", "fake-claude-builder.mjs");
const ONCEBITTEN = path.join(HERE, "helpers", "fake-oncebitten.mjs");
const CURSOR = path.join(HERE, "helpers", "fake-cursor-agent.mjs");
const NTFY = "ntfy-never-print-me";
const TOKEN_IN = "/sandbox/home/.config/ai-collab/ntfy-token";
for (const file of [OPENSHELL, SYSTEMD, AGENT, CLAUDE, ONCEBITTEN, CURSOR]) chmodSync(file, 0o755);

function gitRepo(home) {
  const root = path.join(home, "repo");
  mkdirSync(root, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  writeFileSync(path.join(root, "notes.md"), "# notes\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return root;
}

function assertToken(box, logFiles) {
  const token = path.join(box, "home", ".config", "ai-collab", "ntfy-token");
  const defaults = JSON.parse(readFileSync(path.join(box, "home", ".config", "ai-collab", "defaults.json"), "utf8"));
  assert.equal(defaults.tokenFile, TOKEN_IN);
  assert.equal(readFileSync(token, "utf8").trim(), NTFY);
  assert.equal(statSync(token).mode & 0o777, 0o600);
  for (const file of logFiles) assert.ok(!readFileSync(file, "utf8").includes(NTFY), file);
}

test("a Cursor sandbox stage includes the ntfy token file and a Claude one still does", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-ntfy-stage-"));
  const work = path.join(home, "team-mwu2yt0obe8df3");
  const version = path.join(home, "cursor-agent", "versions", "2026.11.22-fake");
  mkdirSync(version, { recursive: true });
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(version, "cursor-agent"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(path.join(version, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const token = path.join(home, "ntfy-token");
  writeFileSync(token, `${NTFY}\n`, { mode: 0o600 });
  writeFileSync(path.join(home, ".config", "ai-collab", "defaults.json"), JSON.stringify({ url: "http://127.0.0.1:8794", tokenFile: token }));
  execFileSync("git", ["init", "--quiet", "--template=", "-b", "main", work]);
  execFileSync("git", ["-C", work, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", work, "config", "user.email", "test@example.com"]);
  writeFileSync(path.join(work, "notes.md"), "# notes\n");
  execFileSync("git", ["-C", work, "add", "notes.md"]);
  execFileSync("git", ["-C", work, "commit", "--quiet", "-m", "init"]);
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"),
    AI_COLLAB_OPENSHELL_BIN: OPENSHELL, AI_COLLAB_CURSOR_TREE: version,
    FAKE_OPENSHELL_STATE: path.join(home, "openshell.json"), FAKE_OPENSHELL_LOG: path.join(home, "openshell.log"),
    FAKE_CURSOR_LOG: path.join(home, "cursor.log"), FAKE_SANDBOX_CURSOR_BIN: CURSOR,
  };
  const sandbox = await ensureSandbox({ openshell: OPENSHELL, env, name: sandboxName("ai-collab") });
  const logs = [];
  const staged = await prepareSandbox({
    openshell: OPENSHELL, env, sandbox, cwd: work, home, project: "ai-collab", cursorTree: version,
    reuseWorktree: true, log: (line) => logs.push(line),
  });
  assert.equal(staged.workdir, "/sandbox/work/team-mwu2yt0obe8df3");
  await prepareSandbox({
    openshell: OPENSHELL, env, sandbox, cwd: work, home, project: "ai-collab", cursorTree: version,
    reuseWorktree: true, staged: new Set([sandbox]), log: (line) => logs.push(line),
  });
  const box = path.join(home, "sandboxes", sandbox);
  assertToken(box, [env.FAKE_OPENSHELL_LOG]);
  assert.ok(!logs.join("\n").includes(NTFY));
  const projects = JSON.parse(readFileSync(path.join(box, "home", ".config", "ai-collab", "projects.json"), "utf8"));
  assert.equal(projects[0].tokenFile, TOKEN_IN);
  assert.equal(projects[0].project, "ai-collab");
  assert.equal(projects[0].root, staged.workdir);
  assert.ok(!JSON.stringify(projects).includes(token), "the host token path is not the sandbox pointer");

  for (const harness of ["cursor", "claude"]) {
    const built = builderLab(harness);
    assert.equal((await built.cli("task", "add", "Smoke", "task")).out, "smoke-task\n");
    const started = await built.cli("builder", "start", "--task", "smoke-task", "--harness", harness, "--brief", built.brief);
    assert.equal(started.code, 0, started.err);
    assertToken(path.join(built.home, "sandboxes", builderSandbox("smoke-task")), [built.env.FAKE_OPENSHELL_LOG, built.env.FAKE_SYSTEMD_UNIT_LOG, built.env.FAKE_BUILDER_LOG]);
  }
});

function builderLab(harness) {
  const home = mkdtempSync(path.join(os.tmpdir(), `ai-collab-ntfy-${harness}-`));
  const bin = path.join(home, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  symlinkSync(SYSTEMD, path.join(bin, "systemd-run"));
  symlinkSync(SYSTEMD, path.join(bin, "systemctl"));
  const token = path.join(home, "ntfy-token");
  writeFileSync(token, `${NTFY}\n`, { mode: 0o600 });
  const root = gitRepo(home);
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  const env = {
    PATH: `${bin}:${process.env.PATH}`, GIT_EXEC_PATH: process.env.GIT_EXEC_PATH, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
    HOME: home, XDG_DATA_HOME: path.join(home, "data"), XDG_CONFIG_HOME: path.join(home, ".config"),
    AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: harness, AI_COLLAB_STATE_DIR: path.join(home, "state"),
    AI_COLLAB_BUILDER_WORKTREES: home, AI_COLLAB_OPENSHELL_BIN: OPENSHELL, AI_COLLAB_ONCEBITTEN_BIN: ONCEBITTEN,
    AI_COLLAB_BUILDER_NODE: "none", AI_COLLAB_BUILDER_NODE_MODULES: "none", AI_COLLAB_BUILDER_GIT: "none",
    AI_COLLAB_BUILDER_GIT_CORE: "none", AI_COLLAB_BUILDER_ONCEBITTEN: "none", AI_COLLAB_BUILDER_NTFY_TOKEN: token,
    FAKE_OPENSHELL_STATE: path.join(home, "openshell.json"), FAKE_OPENSHELL_LOG: path.join(home, "openshell.log"),
    FAKE_BUILDER_LOG: path.join(home, "agent.log"), FAKE_BUILDER_TASK: "smoke-task",
    FAKE_SYSTEMD_LOG: path.join(home, "systemd.log"), FAKE_SYSTEMD_UNIT_LOG: path.join(home, "unit.log"),
    FAKE_ONCEBITTEN_LOG: path.join(home, "oncebitten.log"),
  };
  if (harness === "cursor") {
    const tree = path.join(home, "cursor-agent", "versions", "2026.11.22-fake");
    mkdirSync(tree, { recursive: true });
    mkdirSync(path.join(home, ".config", "cursor"), { recursive: true });
    for (const file of ["cursor-agent", "node"]) writeFileSync(path.join(tree, file), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(path.join(home, ".config", "cursor", "auth.json"), "{\"token\":\"cursor-auth\"}\n", { mode: 0o600 });
    env.AI_COLLAB_CURSOR_TREE = tree;
    env.FAKE_SANDBOX_CURSOR_BIN = AGENT;
  } else {
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeFileSync(path.join(home, ".claude", ".credentials.json"), "{\"claudeAiOauth\":{\"accessToken\":\"claude-auth\"}}\n", { mode: 0o600 });
    writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "'/h/oncebitten' capture --host claude" }] }] } }));
    env.AI_COLLAB_CLAUDE_BIN = CLAUDE;
  }
  const cli = async (...argv) => {
    let out = "";
    let err = "";
    const code = await runCli(argv, { env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
    return { code, out, err };
  };
  const brief = path.join(home, "brief.md");
  writeFileSync(brief, "Add one line to notes.md.\n");
  return { home, env, cli, brief };
}
