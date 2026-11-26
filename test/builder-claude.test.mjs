// `ai-collab builder start --harness claude`: a lean Claude Code builder in its own sandbox, against the fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../lib/cli.mjs";
import { builderSandbox, claudeMcpConfig, claudeSettings, harnessCommand } from "../lib/builder.ts";
import { taskStoreFile } from "../lib/tasks.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPENSHELL = path.join(HERE, "helpers", "fake-openshell.mjs");
const SYSTEMD = path.join(HERE, "helpers", "fake-systemd-run.mjs");
const CLAUDE = path.join(HERE, "helpers", "fake-claude-builder.mjs");
const ONCEBITTEN = path.join(HERE, "helpers", "fake-oncebitten.mjs");
const CREDS = '{"claudeAiOauth":{"accessToken":"never-print-me-claude"}}\n';
const REFRESHED = '{"claudeAiOauth":{"accessToken":"refreshed-never-print"}}\n';
const NTFY = "ntfy-never-print-me";
const SANDBOX = builderSandbox("smoke-task");
for (const f of [OPENSHELL, SYSTEMD, CLAUDE, ONCEBITTEN]) chmodSync(f, 0o755);

function lab(extra = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-builder-claude-"));
  const root = path.join(home, "repo");
  const bin = path.join(home, "bin");
  for (const dir of [root, bin, path.join(home, ".config", "ai-collab"), path.join(home, ".claude")]) mkdirSync(dir, { recursive: true });
  symlinkSync(SYSTEMD, path.join(bin, "systemd-run"));
  symlinkSync(SYSTEMD, path.join(bin, "systemctl"));
  writeFileSync(path.join(home, ".claude", ".credentials.json"), CREDS, { mode: 0o600 });
  writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "'/h/oncebitten' capture --host claude" }] }] } }));
  const token = path.join(home, "ntfy-token");
  writeFileSync(token, `${NTFY}\n`, { mode: 0o600 });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  writeFileSync(path.join(root, "notes.md"), "# notes\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const env = {
    PATH: `${bin}:${process.env.PATH}`, GIT_EXEC_PATH: process.env.GIT_EXEC_PATH, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH, HOME: home, XDG_DATA_HOME: path.join(home, "data"), XDG_CONFIG_HOME: path.join(home, ".config"),
    AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "claude", AI_COLLAB_STATE_DIR: path.join(home, "state"),
    AI_COLLAB_BUILDER_WORKTREES: home, AI_COLLAB_OPENSHELL_BIN: OPENSHELL, AI_COLLAB_CLAUDE_BIN: CLAUDE, AI_COLLAB_ONCEBITTEN_BIN: ONCEBITTEN,
    AI_COLLAB_BUILDER_NODE: "none", AI_COLLAB_BUILDER_NODE_MODULES: "none", AI_COLLAB_BUILDER_GIT: "none", AI_COLLAB_BUILDER_GIT_CORE: "none",
    AI_COLLAB_BUILDER_ONCEBITTEN: "none", AI_COLLAB_BUILDER_NTFY_TOKEN: token,
    FAKE_OPENSHELL_STATE: path.join(home, "openshell.json"), FAKE_OPENSHELL_LOG: path.join(home, "openshell.log"),
    FAKE_BUILDER_LOG: path.join(home, "agent.log"), FAKE_BUILDER_TASK: "smoke-task",
    FAKE_SYSTEMD_LOG: path.join(home, "systemd.log"), FAKE_SYSTEMD_UNIT_LOG: path.join(home, "unit.log"), FAKE_ONCEBITTEN_LOG: path.join(home, "oncebitten.log"),
    ...extra,
  };
  const cli = async (...argv) => {
    let out = "";
    let err = "";
    const code = await runCli(argv, { env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
    return { code, out, err };
  };
  const brief = path.join(home, "brief.md");
  writeFileSync(brief, "Add one line to notes.md.\n");
  return { home, root, env, cli, brief };
}

const jsonLines = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const task = (l) => JSON.parse(readFileSync(taskStoreFile("demo", l.env), "utf8")).tasks.find((t) => t.id === "smoke-task");
const start = async (l) => {
  assert.equal((await l.cli("task", "add", "Smoke", "task")).out, "smoke-task\n");
  const res = await l.cli("builder", "start", "--task", "smoke-task", "--harness", "claude", "--model", "claude-haiku-5-5", "--brief", l.brief);
  assert.equal(res.code, 0, res.err);
};

test("a Claude builder runs lean in its own sandbox and lands its commit", async () => {
  const l = lab({ FAKE_CLAUDE_REFRESH: REFRESHED });
  await start(l);
  const [agent] = jsonLines(l.env.FAKE_BUILDER_LOG);
  const at = (flag) => agent.args[agent.args.indexOf(flag) + 1];
  assert.equal(at("--model"), "claude-haiku-5-5");
  assert.equal(at("--tools"), "Bash,Read,Edit,Write,Glob,Grep");
  assert.equal(at("--setting-sources"), "");
  for (const flag of ["-p", "--dangerously-skip-permissions", "--strict-mcp-config", "--disable-slash-commands", "--no-chrome"]) assert.ok(agent.args.includes(flag), flag);
  assert.match(agent.args.at(-1), /Add one line to notes\.md\.[\s\S]*oncebitten check --base main/);
  for (const key of ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING", "CLAUDE_CODE_DISABLE_AUTO_MEMORY"]) assert.equal(agent.env[key], "1", key);
  assert.equal(agent.env.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
  assert.ok(agent.settings.permissions.deny.includes("mcp__ai-collab__task_update"));
  assert.ok(agent.settings.permissions.deny.includes("RemoteTrigger"));
  assert.equal(agent.settings.disableArtifact, true);
  assert.equal(agent.settings.hooks.PostToolUse[0].hooks[0].command, "/sandbox/tools/bin/ob-capture claude");
  assert.deepEqual(agent.mcp, { mcpServers: {} });
  // Commit on the host branch, task waiting for review, capture replayed as claude.
  const wt = path.join(l.home, "ai-collab-wt-smoke-task");
  assert.match(execFileSync("git", ["-C", wt, "log", "--format=%s", "-1"], { encoding: "utf8" }), /^docs: claude line\n$/);
  assert.equal(task(l).status, "review");
  assert.equal(task(l).review.commit, execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  assert.deepEqual(jsonLines(l.env.FAKE_ONCEBITTEN_LOG)[0].args, ["capture", "--host", "claude"]);
  // Policy: Anthropic hosts for the uploaded binary only.
  const create = jsonLines(l.env.FAKE_OPENSHELL_LOG).find((a) => a[1] === "create");
  const policy = JSON.parse(readFileSync(create[create.indexOf("--policy") + 1], "utf8"));
  assert.deepEqual(policy.network_policies.claude.endpoints.map((e) => e.host), ["api.anthropic.com", "platform.claude.com", "claude.ai"]);
  assert.deepEqual(policy.network_policies.claude.binaries, [{ path: `/sandbox/claude/${path.basename(CLAUDE)}` }]);
  // Credentials refreshed inside come back 0600; no secret reaches argv or a log.
  const creds = path.join(l.home, ".claude", ".credentials.json");
  assert.equal(readFileSync(creds, "utf8"), REFRESHED);
  assert.equal(statSync(creds).mode & 0o777, 0o600);
  for (const file of [l.env.FAKE_OPENSHELL_LOG, l.env.FAKE_SYSTEMD_LOG, l.env.FAKE_SYSTEMD_UNIT_LOG, l.env.FAKE_BUILDER_LOG]) {
    const text = readFileSync(file, "utf8");
    for (const secret of ["never-print-me-claude", "refreshed-never-print", NTFY]) assert.ok(!text.includes(secret), `${secret} in ${file}`);
  }
  assert.deepEqual(JSON.parse(readFileSync(l.env.FAKE_OPENSHELL_STATE, "utf8")).sandboxes, []);
});

test("host credentials that changed during the run are kept", async () => {
  const l = lab({ FAKE_CLAUDE_REFRESH: REFRESHED });
  l.env.FAKE_HOST_CREDS_TOUCH = path.join(l.home, ".claude", ".credentials.json");
  await start(l);
  assert.equal(readFileSync(l.env.FAKE_HOST_CREDS_TOUCH, "utf8"), '{"host":"changed"}\n');
  assert.match(readFileSync(l.env.FAKE_SYSTEMD_UNIT_LOG, "utf8"), /credentials changed on both sides; kept the host's/);
});

test("with node staged, the ai-collab MCP server, its ntfy config and node's libraries by soname go in", async () => {
  // Any small dynamically linked binary stands in for node here.
  const stand = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const l = lab({ AI_COLLAB_BUILDER_NODE: stand });
  await start(l);
  const [agent] = jsonLines(l.env.FAKE_BUILDER_LOG);
  assert.deepEqual(Object.keys(agent.mcp.mcpServers), ["ai-collab", "ai-collab-code"]);
  const box = path.join(l.home, "sandboxes", SANDBOX);
  assert.ok(existsSync(path.join(box, "tools", "ai-collab", "scripts", "ai-collab-mcp.mjs")));
  const defaults = JSON.parse(readFileSync(path.join(box, "home", ".config", "ai-collab", "defaults.json"), "utf8"));
  assert.deepEqual(defaults, { url: "http://host.openshell.internal:8794", tokenFile: "/sandbox/home/.config/ai-collab/ntfy-token", peers: "claude,codex,cursor" });
  const token = path.join(box, "home", ".config", "ai-collab", "ntfy-token");
  assert.equal(readFileSync(token, "utf8").trim(), NTFY);
  assert.equal(statSync(token).mode & 0o777, 0o600);
  const sonames = [...execFileSync("ldd", [stand], { encoding: "utf8" }).matchAll(/^\s*(\S+) => \//gm)].map((m) => m[1]).filter((n) => !/^(libc|libm|libdl|libpthread|librt)\.so/.test(n));
  for (const name of sonames) assert.ok(existsSync(path.join(box, "tools", "lib", name)), name);
});

test("Claude builder settings, MCP config and argv", () => {
  const settings = claudeSettings(["UserPromptSubmit"]);
  assert.equal(settings.includeGitInstructions, false);
  assert.ok(settings.permissions.deny.includes("CronCreate"));
  assert.deepEqual(Object.keys(settings.hooks), ["UserPromptSubmit"]);
  assert.deepEqual(claudeMcpConfig({ node: "", project: "demo" }), { mcpServers: {} });
  const mcp = claudeMcpConfig({ node: "/usr/bin/node", project: "demo", codeMode: true });
  assert.deepEqual(Object.keys(mcp.mcpServers), ["ai-collab", "ai-collab-code"]);
  assert.deepEqual(mcp.mcpServers["ai-collab"], { command: "/sandbox/tools/node/bin/node", args: ["/sandbox/tools/ai-collab/scripts/ai-collab-mcp.mjs"], env: { AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "claude" } });
  const argv = harnessCommand({ harness: "claude", model: "m", brief: "the brief", workdir: "/w" });
  assert.equal(argv.at(-1), "the brief");
  assert.equal(argv.at(-3), "--settings");
});
