// `ai-collab builder`: a sandboxed builder end to end against fake openshell, systemd-run, agent and oncebitten.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { createServer } from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { runCli } from "../lib/cli.mjs";
import {
  briefNotes, builderPaths, builderAssignment, builderSandbox, builderPolicy, captureHooks, harnessCommand, hostCaptureEvents, parseRecordedCall, replayable, sharedLibs, toolSources,
} from "../lib/builder.mjs";
import { createUi } from "../web/server/ui.mjs";
import { listOwned } from "../lib/owned.mjs";
import { taskStoreFile } from "../lib/tasks.mjs";
import { saveTeamText } from "../lib/patterns.mjs";
import { loadConfig } from "../lib/config.mjs";
import { toolClient } from "../lib/tool-api.mjs";
import { hostCaller } from "../lib/code-run.mjs";
import { setProjectPaused } from "../lib/project-pause.mjs";
import { parseWireEnvelope } from "../lib/agui.mjs";
import { openDurable } from "../runner/durable.mjs";
import { createRunner } from "../runner/runner.mjs";
import { listenControl } from "../runner/control.mjs";
import codexAdapter from "../runner/adapters/codex.mjs";
import { startTaskWakes } from "../runner/task-wake.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { firstUpdate } from "./helpers/ui-stream.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPENSHELL = path.join(HERE, "helpers", "fake-openshell.mjs");
const SYSTEMD = path.join(HERE, "helpers", "fake-systemd-run.mjs");
const AGENT = path.join(HERE, "helpers", "fake-builder-agent.mjs");
const ONCEBITTEN = path.join(HERE, "helpers", "fake-oncebitten.mjs");
const TOKEN = "never-print-me";
const SANDBOX = builderSandbox("smoke-task");
for (const f of [OPENSHELL, SYSTEMD, AGENT, ONCEBITTEN]) chmodSync(f, 0o755);

// A git repo registered as project "demo", one task, fakes on PATH, and a Cursor install tree.
function lab(extra = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-builder-"));
  const root = path.join(home, "repo");
  const bin = path.join(home, "bin");
  const tree = path.join(home, "cursor-agent", "versions", "2026.11.22-fake");
  for (const dir of [root, bin, tree, path.join(home, ".config", "ai-collab"), path.join(home, ".config", "cursor")]) mkdirSync(dir, { recursive: true });
  symlinkSync(SYSTEMD, path.join(bin, "systemd-run"));
  symlinkSync(SYSTEMD, path.join(bin, "systemctl"));
  for (const f of ["cursor-agent", "node"]) writeFileSync(path.join(tree, f), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(path.join(home, ".config", "cursor", "auth.json"), `{"token":"${TOKEN}"}\n`, { mode: 0o600 });
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
    AI_COLLAB_BUILDER_WORKTREES: home, AI_COLLAB_OPENSHELL_BIN: OPENSHELL, AI_COLLAB_CURSOR_TREE: tree, AI_COLLAB_ONCEBITTEN_BIN: ONCEBITTEN,
    AI_COLLAB_BUILDER_NODE: "none", AI_COLLAB_BUILDER_NODE_MODULES: "none", AI_COLLAB_BUILDER_GIT: "none", AI_COLLAB_BUILDER_GIT_CORE: "none",
    AI_COLLAB_BUILDER_ONCEBITTEN: "none",
    FAKE_OPENSHELL_STATE: path.join(home, "openshell.json"), FAKE_OPENSHELL_LOG: path.join(home, "openshell.log"),
    FAKE_SANDBOX_CURSOR_BIN: AGENT, FAKE_BUILDER_LOG: path.join(home, "agent.log"), FAKE_BUILDER_TASK: "smoke-task",
    FAKE_SYSTEMD_LOG: path.join(home, "systemd.log"), FAKE_SYSTEMD_UNIT_LOG: path.join(home, "unit.log"),
    FAKE_ONCEBITTEN_LOG: path.join(home, "oncebitten.log"),
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
  return { home, root, env, cli, brief, git };
}

async function withTask(l) {
  assert.equal((await l.cli("task", "add", "Smoke", "task")).out, "smoke-task\n");
}

const readJsonLines = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const task = (l) => JSON.parse(readFileSync(taskStoreFile("demo", l.env), "utf8")).tasks.find((t) => t.id === "smoke-task");
const wtGit = (l, ...args) => execFileSync("git", ["-C", path.join(l.home, "ai-collab-wt-smoke-task"), ...args], { encoding: "utf8" });

test("builder start leaves a paused project’s task and worktree untouched", async () => {
  const l = lab();
  await withTask(l);
  const cfg = loadConfig(l.env);
  setProjectPaused(cfg, true);
  const refused = await l.cli("builder", "start", "--task", "smoke-task", "--harness", "cursor", "--brief", l.brief);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /New work is paused/);
  assert.equal(task(l).status, "open");
  assert.equal(existsSync(builderPaths("smoke-task", l.env).worktree), false);
});

test("MCP builder_start runs the agent in its own sandbox and lands its commit on the host branch", { timeout: 15000 }, async (t) => {
  const l = lab();
  await withTask(l);
  const session = "0123456789abcdef";
  const client = toolClient({ env: l.env, cwd: l.root });
  const args = { task: "smoke-task", brief: "Add one line to notes.md.", harness: "cursor", session };
  assert.ok(client.listTools().some((tool) => tool.name === "builder_start"));
  await assert.rejects(client.callTool("builder_start", { ...args, branch: "main" }), /not a known argument/);
  await assert.rejects(client.callTool("builder_start", { ...args, model: "--force" }), /Invalid builder model/);
  await assert.rejects(client.callTool("builder_start", { ...args, brief: "--config=value" }), /Start the builder brief/);
  await assert.rejects(client.callTool("builder_start", { ...args, harness: "codex", brief: "a".repeat(4000) }), /brief and sandbox notes/);
  await assert.rejects(hostCaller({ client, session })("builder_start", args), /not available in run_code/);
  const sandbox = toolClient({ env: { ...l.env, AI_COLLAB_BUILDER: "parent" }, cwd: l.root });
  assert.ok(!sandbox.listTools().some((tool) => tool.name === "builder_start"));
  await assert.rejects(sandbox.callTool("builder_start", args), /Unknown tool/);
  assert.equal(existsSync(builderPaths("smoke-task", l.env).worktree), false);

  const script = fileURLToPath(new URL("../scripts/ai-collab-mcp.mjs", import.meta.url));
  const child = spawn(process.execPath, [script, "claude"], { cwd: l.root, env: l.env, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => child.kill());
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "builder_start", arguments: args },
  }) + "\n");
  const response = JSON.parse((await output.next()).value);
  assert.equal(response.id, 1);
  assert.ok(!response.result.isError, response.result.content[0].text);
  const result = JSON.parse(response.result.content[0].text);
  const paths = builderPaths("smoke-task", l.env);
  assert.deepEqual(result, {
    unit: paths.unit, task: "smoke-task", sandbox: SANDBOX, worktree: paths.worktree, branch: "builder/smoke-task",
  });
  assert.ok(readFileSync(paths.brief, "utf8").startsWith(args.brief + "\n"));
  assert.match(wtGit(l, "log", "--format=%s", "-2"), /^docs: add a line\ninit\n$/);
});

test("builder start runs the agent in its own sandbox and lands its commit on the host branch", async () => {
  const l = lab();
  await withTask(l);
  const taskFile = taskStoreFile("demo", l.env);
  l.env.FAKE_OPENSHELL_UPLOAD_TASKS = taskFile;
  const res = await l.cli("builder", "start", "--task", "smoke-task", "--harness", "cursor", "--brief", l.brief);
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, new RegExp(`^builder-smoke-task\tsmoke-task\t${SANDBOX}\t.*ai-collab-wt-smoke-task\tbuilder/smoke-task\n$`));
  const [run] = readJsonLines(l.env.FAKE_SYSTEMD_LOG).filter((a) => a[0] === "systemd-run");
  for (const flag of ["--user", "--collect", "--unit=builder-smoke-task", `--working-directory=${path.join(l.home, "ai-collab-wt-smoke-task")}`, "--setenv=AI_COLLAB_PROJECT=demo", "--setenv=AI_COLLAB_BUILDER_TASK=smoke-task"]) assert.ok(run.includes(flag), flag);
  assert.deepEqual(run.slice(-3), ["builder", "run", "smoke-task"]);
  const uploads = readJsonLines(taskFile + ".uploads");
  assert.ok(uploads.length > 0);
  assert.ok(uploads.every(({ tasks }) => tasks.find(t => t.id === "smoke-task").status === "open"));
  // The commit made inside the sandbox is on the host branch, and the worktree is clean.
  assert.match(wtGit(l, "log", "--format=%s", "-2"), /^docs: add a line\ninit\n$/);
  assert.equal(wtGit(l, "status", "--porcelain").replace(/^\?\? node_modules\n?/m, ""), "");
  // A landed build waits for the operator's verdict, with a phone-sized packet to judge it by.
  assert.equal(task(l).status, "review");
  const packet = task(l).review;
  assert.equal(task(l).progress.at(-1).text, "builder builder-smoke-task: exit 0, 1 commit(s) on builder/smoke-task, 1 oncebitten capture(s)");
  assert.equal(packet.commit, wtGit(l, "rev-parse", "HEAD").trim());
  assert.equal(packet.branch, "builder/smoke-task");
  assert.equal(packet.criteria, "Add one line to notes.md.");
  assert.deepEqual(packet.check, { code: 0, text: "" });
  assert.deepEqual([packet.files, packet.insertions, packet.deletions], [[{ path: "notes.md", insertions: 1, deletions: 0 }], 1, 0]);
  assert.equal(packet.decision, undefined);
  assert.ok(task(l).progress.some((p) => p.text === "half way"));
  assert.ok(task(l).progress.some((p) => /builder builder-smoke-task: exit 0, 1 commit\(s\)/.test(p.text)));
  // The agent ran with the brief, the sandbox notes and Cursor's own sandbox off.
  const [agent] = readJsonLines(l.env.FAKE_BUILDER_LOG);
  assert.deepEqual(agent.args.slice(0, 7), ["-p", "--force", "--trust", "--sandbox", "disabled", "--model", "deepseek-v41-flash-1017-high"]);
  assert.match(agent.args[7], /Add one line to notes\.md\.[\s\S]*oncebitten check --base main/);
  // A new sandbox with the policy, deleted afterwards.
  const calls = readJsonLines(l.env.FAKE_OPENSHELL_LOG);
  const create = calls.find((a) => a[1] === "create");
  assert.ok(create.includes(SANDBOX));
  const policy = JSON.parse(readFileSync(create[create.indexOf("--policy") + 1], "utf8"));
  assert.deepEqual(policy.network_policies.cursor.endpoints[0], { host: "api2.cursor.sh", port: 443, protocol: "tcp", tls: "skip" });
  assert.equal(policy.network_policies.ai_collab.endpoints[0].host, "host.openshell.internal");
  assert.ok(policy.network_policies.cursor.binaries.some((b) => b.path === "/sandbox/agent/2026.11.22-fake/cursor-agent"));
  assert.ok(calls.some((a) => a[1] === "delete" && a[2] === SANDBOX));
  assert.deepEqual(JSON.parse(readFileSync(l.env.FAKE_OPENSHELL_STATE, "utf8")).sandboxes, []);
  // The clone went in with its own .git, unfiltered.
  assert.ok(calls.some((a) => a[1] === "upload" && a.includes("--no-git-ignore") && a.at(-2) === "/sandbox/work/"));
  // The capture was replayed into oncebitten on the host with the host worktree path.
  const [capture] = readJsonLines(l.env.FAKE_ONCEBITTEN_LOG);
  assert.deepEqual(capture.args, ["capture", "--host", "cursor"]);
  assert.equal(JSON.parse(capture.payload).cwd, path.join(l.home, "ai-collab-wt-smoke-task"));
  // The auth token never reaches argv or a log.
  for (const file of [l.env.FAKE_OPENSHELL_LOG, l.env.FAKE_SYSTEMD_LOG, l.env.FAKE_SYSTEMD_UNIT_LOG, l.env.FAKE_BUILDER_LOG]) {
    assert.ok(!readFileSync(file, "utf8").includes(TOKEN), file);
  }
  const state = JSON.parse(readFileSync(builderPaths("smoke-task", l.env).state, "utf8"));
  assert.equal(state.phase, "finished");
  assert.equal(state.sandboxDeleted, true);
});

test("a Cursor builder reaches a fake API with process inspection enabled and lands its commit", async (t) => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push([req.method, req.url, req.headers.host]);
    res.end("cursor-ok");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const l = lab({ FAKE_CURSOR_API_PORT: String(server.address().port) });
  await withTask(l);
  const result = await l.cli("builder", "start", "--task", "smoke-task", "--harness", "cursor", "--brief", l.brief);
  assert.equal(result.code, 0, result.err);
  const run = readJsonLines(l.env.FAKE_OPENSHELL_LOG).find((a) => a[1] === "exec" && a.includes("cursor-agent"));
  assert.ok(run, "no exec of cursor-agent");
  assert.equal(run[run.indexOf("CURSOR_AGENT_ALLOW_PROCESS_INSPECTION=1") - 1], "--env");
  assert.equal(run[run.indexOf("AI_COLLAB_PROJECT=demo") - 1], "--env");
  assert.deepEqual(requests, [["GET", "/probe", "api2.cursor.sh"]]);
  assert.equal(wtGit(l, "rev-list", "--count", "main..HEAD").trim(), "1");
  assert.equal(task(l).status, "review");
});

test("uncommitted work is committed on the host and waits for review", async () => {
  const l = lab({ FAKE_BUILDER_MODE: "dirty" });
  await withTask(l);
  assert.equal((await l.cli("builder", "start", "--task", "smoke-task", "--harness", "cursor", "--brief", l.brief)).code, 0);
  assert.match(wtGit(l, "log", "--format=%s", "-1"), /^chore\(builder\): uncommitted work from smoke-task\n$/);
  assert.match(wtGit(l, "log", "--format=%b", "-1"), /Assisted-by: Cursor:deepseek-v41-flash-1017-high/);
  assert.equal(task(l).status, "review");
});

test("an agent that fails with no work leaves the task blocked and the sandbox deleted", async () => {
  const l = lab({ FAKE_BUILDER_MODE: "fail" });
  await withTask(l);
  assert.equal((await l.cli("builder", "start", "--task", "smoke-task", "--harness", "cursor", "--brief", l.brief)).code, 0);
  assert.equal(task(l).status, "blocked");
  assert.match(task(l).detail, /exited 3 with 0 commit\(s\) and set no status/);
  assert.deepEqual(JSON.parse(readFileSync(l.env.FAKE_OPENSHELL_STATE, "utf8")).sandboxes, []);
});

test("a firing oncebitten check publishes one blocked PM wake", { timeout: 15_000 }, async (t) => {
  const l = lab({ FAKE_ONCEBITTEN_CHECK: "1" });
  l.env.FAKE_ONCEBITTEN_TASK_STORE = taskStoreFile("demo", l.env);
  await withTask(l);
  const wakes = [];
  let wake;
  const woken = new Promise(resolve => { wake = resolve; });
  const [stop] = startTaskWakes([{ name: "pm", wakeOnTasks: "demo" }], {
    runSchedule(name, reason) {
      wakes.push([name, reason, task(l).status]);
      wake();
      return { status: "started" };
    },
  }, { env: l.env, everyMs: 5 });
  t.after(stop);
  assert.equal((await l.cli("builder", "start", "--task", "smoke-task", "--harness", "cursor", "--brief", l.brief)).code, 0);
  await woken;
  assert.deepEqual(wakes, [["pm", "task-wake", "blocked"]]);
  assert.equal(readJsonLines(l.env.FAKE_ONCEBITTEN_LOG).find(row => row.args[0] === "check").status, "building");
  assert.match(task(l).detail, /oncebitten check --base main fired: no-sleep-in-tests/);
});

test("a done request with no collected commits is blocked", async () => {
  const l = lab({ FAKE_BUILDER_MODE: "empty" });
  await withTask(l);
  assert.equal((await l.cli("builder", "start", "--task", "smoke-task", "--harness", "cursor", "--brief", l.brief)).code, 0);
  assert.equal(task(l).status, "blocked");
  assert.match(task(l).detail, /0 commit\(s\) and requested done/);
});

test("an unavailable configured checker blocks a landed branch", async () => {
  const l = lab();
  mkdirSync(path.join(l.root, ".oncebitten"));
  writeFileSync(path.join(l.root, ".oncebitten", "rules.lock"), 'source = ["configured"]\n');
  l.git("add", "-A");
  l.git("commit", "-qm", "configure rules");
  l.env.AI_COLLAB_ONCEBITTEN_BIN = path.join(l.home, "missing-checker");
  await withTask(l);
  assert.equal((await l.cli("builder", "start", "--task", "smoke-task", "--harness", "cursor", "--brief", l.brief)).code, 0);
  assert.equal(task(l).status, "blocked");
  assert.match(task(l).detail, /oncebitten check --base main could not run:.*ENOENT/);
  assert.match(wtGit(l, "log", "-1", "--format=%s"), /docs: add a line/);
});

test("a restarted runner resumes a saved verdict and skips an already published transition", async () => {
  const l = lab();
  await withTask(l);
  await l.cli("task", "set", "smoke-task", "status=building");
  const paths = builderPaths("smoke-task", l.env);
  mkdirSync(paths.dir, { recursive: true });
  const state = {
    id: "smoke-task", task: "smoke-task", project: "demo", harness: "codex", owned: true,
    unit: "builder-smoke-task", phase: "collected",
    settlement: { status: "done", progress: "finished", at: Date.now() },
  };
  const resume = () => execFileSync(process.execPath, ["--input-type=module", "-e",
    'import { finishOwnedBuilder, ownedBuilder } from "./lib/builder.mjs"; await finishOwnedBuilder(ownedBuilder("demo", "smoke-task", process.env), null, 1, process.env, () => {});',
  ], { env: { ...process.env, ...l.env } });
  writeFileSync(paths.state, JSON.stringify(state));
  resume();
  assert.equal(task(l).status, "done");
  // Simulate a cut after publication, before the builder state was advanced.
  writeFileSync(paths.state, JSON.stringify(state));
  await l.cli("task", "set", "smoke-task", "status=building");
  resume();
  assert.equal(task(l).status, "building");
  assert.equal(task(l).progress.filter(p => p.text === "finished").length, 1);
  assert.equal(JSON.parse(readFileSync(paths.state, "utf8")).phase, "finished");
});

test("an existing sandbox of the same name is neither reused nor deleted", async () => {
  const l = lab();
  await withTask(l);
  writeFileSync(l.env.FAKE_OPENSHELL_STATE, JSON.stringify({ sandboxes: [{ name: SANDBOX, phase: "Ready" }] }));
  assert.equal((await l.cli("builder", "start", "--task", "smoke-task", "--harness", "cursor", "--brief", l.brief)).code, 0);
  assert.equal(JSON.parse(readFileSync(l.env.FAKE_OPENSHELL_STATE, "utf8")).sandboxes.length, 1);
  assert.equal(task(l).status, "blocked");
  assert.match(task(l).detail, new RegExp(`sandbox ${SANDBOX} already exists`));
  assert.equal(readJsonLines(l.env.FAKE_BUILDER_LOG).length, 0);
});

test("builder list shows live builders and stop ends only builders it started", async () => {
  const l = lab();
  await withTask(l);
  await l.cli("builder", "start", "--task", "smoke-task", "--harness", "cursor", "--brief", l.brief);
  assert.equal((await l.cli("builder", "list")).out, "");
  assert.equal((await l.cli("builder", "list", "--all")).out, `builder-smoke-task\tsmoke-task\t${SANDBOX}\tfinished\tinactive\n`);
  l.env.FAKE_SYSTEMCTL_STATE = "active";
  assert.equal((await l.cli("builder", "list")).out, `builder-smoke-task\tsmoke-task\t${SANDBOX}\tfinished\tactive\n`);
  const unknown = await l.cli("builder", "stop", "agents");
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /no builder agents started by ai-collab builder start/);
  assert.ok(!readJsonLines(l.env.FAKE_SYSTEMD_LOG).some((a) => a[0] === "systemctl" && a.includes("stop")));
  const stop = await l.cli("builder", "stop", "smoke-task");
  assert.equal(stop.code, 0);
  assert.equal(stop.out, "builder-smoke-task\tstopped\tsandbox deleted\n");
  assert.ok(readJsonLines(l.env.FAKE_SYSTEMD_LOG).some((a) => a[0] === "systemctl" && a.join(" ") === "systemctl --user stop builder-smoke-task"));
});

test("builder start refuses a bad harness, a missing task and an existing worktree", async () => {
  const l = lab();
  await withTask(l);
  assert.equal((await l.cli("builder", "start", "--task", "smoke-task", "--harness", "unknown", "--brief", l.brief)).code, 1);
  assert.match((await l.cli("builder", "start", "--task", "nope", "--harness", "cursor", "--brief", l.brief)).err, /no task nope/);
  mkdirSync(path.join(l.home, "ai-collab-wt-smoke-task"));
  assert.match((await l.cli("builder", "start", "--task", "smoke-task", "--harness", "cursor", "--brief", l.brief)).err, /already exists/);
  assert.equal(readJsonLines(l.env.FAKE_SYSTEMD_LOG).length, 0);
});

test("harness argv, policy, hooks and recorded calls", () => {
  // Codex gets the hook-trust flag: without it a headless run in a fresh worktree fires no hooks at all.
  assert.deepEqual(harnessCommand({ harness: "codex", model: "gpt-6.2-sol", brief: "b", workdir: "/sandbox/work/x" }),
    ["codex", "exec", "-m", "gpt-6.2-sol", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--skip-git-repo-check", "-C", "/sandbox/work/x", "b"]);
  const policy = builderPolicy({ harness: "codex", binaries: ["/sandbox/codex/r/bin/codex"], ntfyBinaries: ["/sandbox/tools/node/bin/node"] });
  assert.ok(policy.network_policies.codex.endpoints.some((e) => e.host === "chatgpt.com"));
  assert.deepEqual(policy.network_policies.ai_collab.binaries.map((b) => b.path), ["/sandbox/codex/r/bin/codex", "/sandbox/tools/node/bin/node"]);
  assert.deepEqual(captureHooks("codex", ["UserPromptSubmit"]), { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "/sandbox/tools/bin/ob-capture codex" }] }] } });
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai-collab-builder-hooks-"));
  const file = path.join(dir, "hooks.json");
  writeFileSync(file, JSON.stringify({ hooks: { stop: [{ command: "x" }], postToolUse: [{ command: "'/h/.cargo/bin/oncebitten' capture --host cursor" }], preToolUse: [{ command: "oncebitten steer --host cursor" }] } }));
  assert.deepEqual(hostCaptureEvents("cursor", file), ["postToolUse"]);
  assert.deepEqual(hostCaptureEvents("codex", path.join(dir, "missing.json")), ["UserPromptSubmit"]);
  assert.deepEqual(parseRecordedCall("task\0set\0t\0status=done\0"), ["task", "set", "t", "status=done"]);
  assert.equal(replayable(["task", "set", "t", "status=done"]), true);
  assert.equal(replayable(["task", "add", "x", "y"]), false);
  assert.equal(replayable(["send", "all", "x", "y"]), false);
  assert.match(briefNotes({ task: "t", branch: "b", workdir: "/sandbox/work/w" }), /oncebitten check --base main/);
});

test("an OpenCode builder dials its APIs with its own TLS", () => {
  // Through OpenShell's TLS-terminating proxy, Zen answers free models with FreeUsageLimitError (measured 2026-11-22).
  const policy = builderPolicy({ harness: "opencode", binaries: ["/sandbox/opencode/opencode"] });
  assert.deepEqual(policy.network_policies.opencode.endpoints, [
    { host: "opencode.ai", port: 443, protocol: "tcp", tls: "skip" },
    { host: "models.dev", port: 443, protocol: "tcp", tls: "skip" },
  ]);
  assert.equal(policy.network_policies.ai_collab.endpoints[0].protocol, "rest");
});

test("sharedLibs lists a binary's libraries without glibc's own", async () => {
  const libs = await sharedLibs(process.execPath);
  assert.ok(Array.isArray(libs));
  assert.ok(libs.every((p) => path.isAbsolute(p) && !/^(libc|libm|libdl|libpthread|librt|ld-linux)\./.test(path.basename(p))));
});

test("sandbox staging discovers oncebitten in Cargo's bin directory when the service PATH omits it", (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-oncebitten-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = { harness: "codex", root: home };
  const env = { HOME: home, PATH: "/usr/bin:/bin" };
  for (const cargoHome of [path.join(home, ".cargo"), path.join(home, "custom-cargo")]) {
    const bin = path.join(cargoHome, "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(ONCEBITTEN, path.join(bin, "oncebitten"));
  }
  assert.equal(toolSources(state, env).oncebitten, ONCEBITTEN);
  assert.equal(toolSources(state, { ...env, HOME: path.join(home, "other"), CARGO_HOME: path.join(home, "custom-cargo") }).oncebitten, ONCEBITTEN);
  assert.equal(toolSources(state, { ...env, AI_COLLAB_BUILDER_ONCEBITTEN: "none" }).oncebitten, "");
});

test("a CODEX_HOME with no login falls back to the user's ~/.codex login", async () => {
  const { toolSources } = await import("../lib/builder.mjs");
  const { homedir } = await import("node:os");
  const { existsSync, mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const empty = mkdtempSync(join((await import("node:os")).tmpdir(), "ai-collab-codex-home-"));
  const src = toolSources({ harness: "codex", root: empty }, { PATH: "", HOME: empty, CODEX_HOME: empty });
  const own = join(homedir(), ".codex", "auth.json");
  assert.equal(src.codexAuth, existsSync(own) ? own : "");
});

async function ownedBuilderTest(t, prompt, { restart = false } = {}) {
  const ntfy = await startFakeNtfy();
  t.after(() => ntfy.close());
  const l = lab({ AI_COLLAB_URL: ntfy.url, AI_COLLAB_PEERS: "claude,codex,operator" });
  const tree = path.join(l.home, "codex-release");
  mkdirSync(path.join(tree, "bin"), { recursive: true });
  writeFileSync(path.join(tree, "bin", "codex"),
    '#!/bin/sh\nexec node "' + path.join(HERE, "helpers", "fake-codex-app-server.mjs") + '" "$@"\n', { mode: 0o755 });
  Object.assign(l.env, {
    AI_COLLAB_CODEX_TREE: tree,
    AI_COLLAB_RUNNER_SOCKET: path.join(l.home, "s"),
    FAKE_CODEX_LOG: path.join(l.home, "codex.log"),
  });
  await withTask(l);
  writeFileSync(l.brief, prompt);
  const cfg = loadConfig(l.env, { cwd: l.root });
  const hostLog = path.join(l.home, "host-codex.log");
  const hostCodex = path.join(l.home, "bin", "codex");
  writeFileSync(hostCodex, '#!/bin/sh\nprintf "launched\\n" >> "$1"\nexit 1\n', { mode: 0o755 });
  const makeRunner = () => createRunner({
    projects: [cfg], adapters: new Map([["codex", codexAdapter({ command: { file: hostCodex, args: [hostLog] } })]]),
    durable: openDurable(path.join(l.home, "runner.db")), env: l.env, watch: false,
  });
  let runner = makeRunner();
  t.after(() => runner.stop());
  const control = await listenControl(runner, l.env.AI_COLLAB_RUNNER_SOCKET);
  t.after(() => control.close());
  const worktrees = l.git("worktree", "list", "--porcelain");
  await assert.rejects(runner.start({ project: "demo", harness: "codex", place: "openshell", prompt: "Build" }),
    { status: 400, message: /require a tracked builder/ });
  await saveTeamText(cfg, "sandboxrole", 'digraph sandboxrole { worker [agent=codex, prompt="Build"]; worker -> done [on="ready"]; }', l.env, {});
  await assert.rejects(runner.startPattern({ project: "demo", name: "sandboxrole", task: "Build" }),
    { status: 400, message: /require a tracked builder/ });
  assert.equal(l.git("worktree", "list", "--porcelain"), worktrees);
  assert.deepEqual(runner.list(), []);
  assert.equal(existsSync(hostLog), false);
  assert.deepEqual(readJsonLines(l.env.FAKE_OPENSHELL_LOG), []);
  const res = await l.cli("builder", "start", "--task", "smoke-task", "--harness", "codex", "--run", "run123", "--brief", l.brief);
  assert.equal(res.code, 0, res.err);
  const address = res.out.split("\t")[0];
  assert.match(address, /^codex#[0-9a-f]{16}$/);
  assert.equal(task(l).owner, address);
  assert.equal(task(l).run, "run123");
  if (prompt === "hang") assert.equal(task(l).status, "building");
  assert.equal(runner.get(address).taskId, "smoke-task");
  assert.match((await l.cli("builder", "list")).out, /codex#/);
  assert.ok(readJsonLines(l.env.FAKE_SYSTEMD_LOG).every(row => row[0] !== "systemd-run"));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !readJsonLines(l.env.FAKE_CODEX_LOG).some(row => row.method === "turn/start")) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const turn = readJsonLines(l.env.FAKE_CODEX_LOG).find(row => row.method === "turn/start");
  const launches = readJsonLines(l.env.FAKE_OPENSHELL_LOG).filter(args => args[1] === "exec" && args.includes("app-server"));
  assert.equal(launches.length, 1);
  assert.equal(launches[0][launches[0].indexOf("-n") + 1], SANDBOX);
  assert.equal(existsSync(hostLog), false);
  assert.ok(turn?.params.input[0].text.startsWith(prompt));
  assert.match(turn.params.input[0].text, /oncebitten check --base main/);
  if (prompt === "limit") {
    while (Date.now() < deadline && runner.get(address).status !== "ended") {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(runner.get(address).status, "ended");
    assert.equal(task(l).status, "review");
    assert.match(wtGit(l, "show", "HEAD:notes.md"), /a line from the builder/);
    assert.equal(readJsonLines(l.env.FAKE_BUILDER_LOG).length, 1);
    assert.deepEqual(JSON.parse(readFileSync(l.env.FAKE_OPENSHELL_STATE, "utf8")).sandboxes, []);
    return;
  }
  assert.equal(builderAssignment("demo", task(l), listOwned(cfg), l.env), null);
  const paths = builderPaths("smoke-task", l.env);
  appendFileSync(path.join(l.home, "sandboxes", SANDBOX, "work", path.basename(paths.worktree), "notes.md"), "pending Codex edit\n");
  if (restart) {
    await runner.stop();
    runner = makeRunner();
    assert.equal((await runner.boot()).length, 1);
    const resumedDeadline = Date.now() + 5000;
    while (Date.now() < resumedDeadline && runner.get(address).status !== "ended") {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(runner.get(address).status, "ended");
    assert.equal(task(l).status, "review");
    assert.equal(task(l).owner, address);
    assert.match(wtGit(l, "show", "HEAD:notes.md"), /pending Codex edit/);
    const calls = readJsonLines(l.env.FAKE_CODEX_LOG);
    const resume = calls.find(row => row.method === "thread/resume");
    assert.equal(resume?.params.threadId, turn.params.threadId);
    const turns = calls.filter(row => row.method === "turn/start");
    assert.equal(turns.length, 2);
    assert.match(turns[1].params.input[0].text, /^The runner restarted/);
    const sandboxCalls = readJsonLines(l.env.FAKE_OPENSHELL_LOG);
    assert.equal(sandboxCalls.filter(args => args[1] === "create").length, 1);
    assert.deepEqual(JSON.parse(readFileSync(l.env.FAKE_OPENSHELL_STATE, "utf8")).sandboxes, []);
    return;
  }
  const stopped = await l.cli("builder", "stop", "smoke-task");
  assert.equal(stopped.code, 0, stopped.err);
  assert.equal(runner.get(address).status, "ended");
  await runner.settle();
  const label = address.split("#")[1];
  const activity = ntfy.state.publishes
    .filter(row => row.topic === "ai-collab-demo--activity")
    .map(row => parseWireEnvelope(row.message))
    .filter(row => row?.session === label);
  assert.ok(activity.some(row => row.type === "prompt" && row.system === true && row.input?.startsWith("hang")));
  assert.ok(activity.some(row => row.type === "stop"));
  assert.equal(task(l).status, "blocked");
  assert.equal(task(l).owner, address);
  assert.deepEqual(JSON.parse(readFileSync(l.env.FAKE_OPENSHELL_STATE, "utf8")).sandboxes, []);
  const { recovery } = builderAssignment("demo", task(l), listOwned(cfg), l.env);
  assert.equal(recovery.worktree, paths.worktree);
  assert.equal(recovery.commits, 1);
  const ui = createUi({ cfg, env: l.env, allowedOrigin: "https://localhost" });
  t.after(() => ui.close());
  const stream = new AbortController();
  try {
    const snapshot = await firstUpdate(ui.events(new Request("https://localhost/api/events?project=demo", { signal: stream.signal })), "state");
    assert.deepEqual(snapshot.tasks.tasks[0].recovery, recovery);
    assert.match(snapshot.tasks.tasks[0].last.text, /1 commit/);
  } finally {
    stream.abort();
  }
  const response = await ui.handle(new Request("https://localhost/api/recover-builder", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://localhost" },
    body: JSON.stringify({ project: "demo", id: "smoke-task", harness: "cursor" }),
  }), "recover-builder");
  assert.equal(response.status, 201, await response.text());
  assert.match(wtGit(l, "show", "HEAD:notes.md"), /pending Codex edit\na line from the builder/);
  assert.equal(task(l).owner, undefined);
  assert.equal(runner.get(address).status, "ended");
  const [replacement, ...otherLaunches] = readJsonLines(l.env.FAKE_BUILDER_LOG);
  assert.deepEqual(otherLaunches, []);
  assert.match(replacement.args.at(-1), /Recover the unfinished assignment[\s\S]*Last task update:/);
}

test("Codex builder links its task before sending the brief", (t) => ownedBuilderTest(t, "hang"));
test("runner restart resumes a Codex builder in its original sandbox", (t) => ownedBuilderTest(t, "hang", { restart: true }));
test("runner-owned Codex retries a usage limit with Cursor", (t) => ownedBuilderTest(t, "limit"));

test("Codex builder uses the standalone unit when the control socket is absent", async () => {
  const l = lab();
  l.env.AI_COLLAB_RUNNER_SOCKET = path.join(l.home, "missing.sock");
  const tree = path.join(l.home, "codex-release");
  mkdirSync(path.join(tree, "bin"), { recursive: true });
  const codex = path.join(tree, "bin", "codex");
  writeFileSync(codex, '#!/bin/sh\n[ "$1" = exec ] || exit 1\nprintf "built\\n" >> notes.md\n', { mode: 0o755 });
  symlinkSync(codex, path.join(l.home, "bin", "codex"));
  l.env.AI_COLLAB_CODEX_TREE = tree;
  await withTask(l);
  const res = await l.cli("builder", "start", "--task", "smoke-task", "--harness", "codex", "--brief", l.brief);
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, /^builder-smoke-task\t/);
  assert.ok(readJsonLines(l.env.FAKE_SYSTEMD_LOG).some(row => row[0] === "systemd-run"));
  assert.equal(task(l).status, "review");
  assert.equal(task(l).owner, undefined);
});

test("a Cursor usage limit is visible on the task and stops later dispatches for that model", async () => {
  const l = lab({ FAKE_BUILDER_MODE: "cursor-limit" });
  await withTask(l);
  const first = await l.cli("builder", "start", "--task", "smoke-task", "--harness", "cursor", "--brief", l.brief);
  assert.equal(first.code, 0, first.err);
  assert.equal(task(l).status, "blocked");
  assert.match(task(l).detail, /reached its usage limit.*2099-12-19/);
  assert.equal((await l.cli("task", "add", "Second task")).code, 0);
  const retry = await l.cli("builder", "start", "--task", "second-task", "--harness", "cursor", "--brief", l.brief);
  assert.equal(retry.code, 1);
  assert.match(retry.err, /reached its usage limit/);
  assert.equal(existsSync(builderPaths("second-task", l.env).worktree), false);
  assert.equal(readJsonLines(l.env.FAKE_BUILDER_LOG).length, 1);
  l.env.FAKE_BUILDER_MODE = "dirty";
  const other = await l.cli("builder", "start", "--task", "second-task", "--harness", "cursor", "--model", "other-model", "--brief", l.brief);
  assert.equal(other.code, 0, other.err);
  assert.equal(readJsonLines(l.env.FAKE_BUILDER_LOG).length, 2);
});

for (const [label, stream, failDownload] of [
  ["carries edits forward after a stderr limit", "stderr", false],
  ["carries edits forward after a stdout limit", "stdout", false],
  ["retains the retry sandbox when collection fails", "stdout", true],
]) {
  test("standalone Codex fallback " + label, async () => {
    const l = lab(failDownload ? { FAKE_FAIL_RETRY_DOWNLOAD: "1" } : {});
    l.env.AI_COLLAB_RUNNER_SOCKET = path.join(l.home, "missing.sock");
    const tree = path.join(l.home, "codex-release");
    mkdirSync(path.join(tree, "bin"), { recursive: true });
    const codex = path.join(tree, "bin", "codex");
    writeFileSync(codex, '#!/bin/sh\necho "Codex partial edit" >> notes.md\necho "ERROR: Usage limit reached"' + (stream === "stderr" ? " >&2" : "") + '\nexit 1\n', { mode: 0o755 });
    symlinkSync(codex, path.join(l.home, "bin", "codex"));
    l.env.AI_COLLAB_CODEX_TREE = tree;
    writeFileSync(path.join(l.env.XDG_CONFIG_HOME, "ai-collab", "defaults.json"), JSON.stringify({ builderOrder: ["codex", "cursor"] }));
    await withTask(l);
    const res = await l.cli("builder", "start", "--task", "smoke-task", "--brief", l.brief);
    assert.equal(res.code, 0, res.err);
    const [cursor] = readJsonLines(l.env.FAKE_BUILDER_LOG);
    assert.equal(cursor.args[6], "deepseek-v41-flash-1017-high");
    const calls = readJsonLines(l.env.FAKE_OPENSHELL_LOG);
    assert.equal(calls.filter((row) => row[1] === "create").length, 2);
    assert.equal(calls.filter((row) => row[1] === "delete").length, failDownload ? 1 : 2);
    if (failDownload) {
      assert.equal(task(l).status, "blocked");
      assert.match(task(l).detail, /sandbox download failed/);
      const recovery = builderAssignment("demo", task(l), [], l.env)?.recovery;
      assert.equal(recovery?.sandboxWorkspace, true);
      return;
    }
    assert.equal(task(l).status, "review");
    assert.match(wtGit(l, "show", "HEAD:notes.md"), /Codex partial edit\na line from the builder/);
    assert.ok(readJsonLines(l.env.FAKE_ONCEBITTEN_LOG).some((row) => row.args[0] === "check"));
  });
}

for (const harness of ["cursor", "opencode"]) {
  test(`${harness} stages a local code MCP server in the builder sandbox`, async () => {
    const l = lab({ AI_COLLAB_BUILDER_NODE: process.execPath, AI_COLLAB_OPENCODE_BIN: AGENT, FAKE_SANDBOX_OPENCODE_BIN: AGENT });
    await withTask(l);
    const started = await l.cli("builder", "start", "--task", "smoke-task", "--harness", harness, "--brief", l.brief);
    assert.equal(started.code, 0, started.err);
    const home = path.join(l.home, "sandboxes", SANDBOX, "home");
    const cursor = harness === "cursor";
    const config = JSON.parse(readFileSync(path.join(home, cursor ? ".cursor/mcp.json" : ".config/opencode/opencode.json"), "utf8"));
    const server = (cursor ? config.mcpServers : config.mcp.servers)["ai-collab-code"];
    assert.deepEqual(cursor ? [server.command, ...server.args] : server.command, [
      "/sandbox/tools/node/bin/node",
      "/sandbox/tools/ai-collab/scripts/ai-collab-code-mcp.mjs",
      "--builder-local",
      "/sandbox/work/ai-collab-wt-smoke-task",
    ]);
    const [agent] = readJsonLines(l.env.FAKE_BUILDER_LOG);
    assert.match(agent.args.at(-1), /run_code to batch/);
    if (cursor) assert.ok(agent.args.includes("--approve-mcps"));
    else {
      assert.equal(server.codemode, false);
      assert.deepEqual(agent.args.slice(0, 5), ["run", "--standalone", "--auto", "--format", "json"]);
    }
    assert.equal(task(l).status, "review");
  });
}

test("defaults.json limitFallback picks the harness a Codex usage limit retries with", async () => {
  const l = lab({ AI_COLLAB_OPENCODE_BIN: AGENT, FAKE_SANDBOX_OPENCODE_BIN: AGENT });
  l.env.AI_COLLAB_RUNNER_SOCKET = path.join(l.home, "missing.sock");
  const tree = path.join(l.home, "codex-release");
  mkdirSync(path.join(tree, "bin"), { recursive: true });
  const codex = path.join(tree, "bin", "codex");
  writeFileSync(codex, '#!/bin/sh\necho "Usage limit reached" >&2\nexit 1\n', { mode: 0o755 });
  symlinkSync(codex, path.join(l.home, "bin", "codex"));
  l.env.AI_COLLAB_CODEX_TREE = tree;
  writeFileSync(path.join(l.env.XDG_CONFIG_HOME, "ai-collab", "defaults.json"), JSON.stringify({ builderOrder: ["codex"], limitFallback: "opencode:opencode/deepseek-v4.1-flash-free" }));
  await withTask(l);
  const res = await l.cli("builder", "start", "--task", "smoke-task", "--brief", l.brief);
  assert.equal(res.code, 0, res.err);
  const [retry] = readJsonLines(l.env.FAKE_BUILDER_LOG);
  assert.ok(retry.args.includes("opencode/deepseek-v4.1-flash-free"), JSON.stringify(retry.args));
});

test("a Codex usage limit skips a Cursor model that is already limited and retries with OpenCode", async () => {
  const l = lab({ AI_COLLAB_OPENCODE_BIN: AGENT, FAKE_SANDBOX_OPENCODE_BIN: AGENT, FAKE_BUILDER_MODE: "cursor-limit" });
  l.env.AI_COLLAB_RUNNER_SOCKET = path.join(l.home, "missing.sock");
  writeFileSync(path.join(l.env.XDG_CONFIG_HOME, "ai-collab", "defaults.json"), JSON.stringify({ builderOrder: ["codex"], limitFallback: "cursor:deepseek-v41-flash-1017-high" }));
  await withTask(l);
  const blocked = await l.cli("builder", "start", "--task", "smoke-task", "--harness", "cursor", "--brief", l.brief);
  assert.equal(blocked.code, 0, blocked.err);
  assert.match(task(l).detail, /reached its usage limit/);
  const tree = path.join(l.home, "codex-release");
  mkdirSync(path.join(tree, "bin"), { recursive: true });
  const codex = path.join(tree, "bin", "codex");
  writeFileSync(codex, '#!/bin/sh\necho "Usage limit reached" >&2\nexit 1\n', { mode: 0o755 });
  symlinkSync(codex, path.join(l.home, "bin", "codex"));
  l.env.AI_COLLAB_CODEX_TREE = tree;
  l.env.FAKE_BUILDER_MODE = "commit";
  l.env.FAKE_BUILDER_TASK = "second-task";
  assert.equal((await l.cli("task", "add", "Second task")).code, 0);
  const res = await l.cli("builder", "start", "--task", "second-task", "--brief", l.brief);
  assert.equal(res.code, 0, res.err);
  const launches = readJsonLines(l.env.FAKE_BUILDER_LOG);
  assert.ok(launches.at(-1).args.includes("opencode/deepseek-v4.1-flash-free"), JSON.stringify(launches.at(-1).args));
  assert.equal(launches.filter((row) => row.args.includes("deepseek-v41-flash-1017-high")).length, 1);
});
