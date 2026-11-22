// `ai-collab builder`: a sandboxed builder end to end against fake openshell, systemd-run, agent and oncebitten.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../lib/cli.mjs";
import {
  briefNotes, builderPaths, builderSandbox, builderPolicy, captureHooks, harnessCommand, hostCaptureEvents, parseRecordedCall, replayable, sharedLibs,
} from "../lib/builder.mjs";
import { taskStoreFile } from "../lib/tasks.mjs";

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
    PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_DATA_HOME: path.join(home, "data"), XDG_CONFIG_HOME: path.join(home, ".config"),
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

test("builder start runs the agent in its own sandbox and lands its commit on the host branch", async () => {
  const l = lab();
  await withTask(l);
  const res = await l.cli("builder", "start", "--task", "smoke-task", "--harness", "cursor", "--brief", l.brief);
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, new RegExp(`^builder-smoke-task\tsmoke-task\t${SANDBOX}\t.*ai-collab-wt-smoke-task\tbuilder/smoke-task\n$`));
  const [run] = readJsonLines(l.env.FAKE_SYSTEMD_LOG).filter((a) => a[0] === "systemd-run");
  for (const flag of ["--user", "--collect", "--unit=builder-smoke-task", `--working-directory=${path.join(l.home, "ai-collab-wt-smoke-task")}`, "--setenv=AI_COLLAB_PROJECT=demo", "--setenv=AI_COLLAB_BUILDER_TASK=smoke-task"]) assert.ok(run.includes(flag), flag);
  assert.deepEqual(run.slice(-3), ["builder", "run", "smoke-task"]);
  // The commit made inside the sandbox is on the host branch, and the worktree is clean.
  assert.match(wtGit(l, "log", "--format=%s", "-2"), /^docs: add a line\ninit\n$/);
  assert.equal(wtGit(l, "status", "--porcelain").replace(/^\?\? node_modules\n?/m, ""), "");
  assert.equal(task(l).status, "done");
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
  assert.deepEqual(policy.network_policies.cursor.endpoints.map((e) => e.host).slice(0, 1), ["api2.cursor.sh"]);
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

test("uncommitted work is committed on the host and the task is marked done", async () => {
  const l = lab({ FAKE_BUILDER_MODE: "dirty" });
  await withTask(l);
  assert.equal((await l.cli("builder", "start", "--task", "smoke-task", "--harness", "cursor", "--brief", l.brief)).code, 0);
  assert.match(wtGit(l, "log", "--format=%s", "-1"), /^chore\(builder\): uncommitted work from smoke-task\n$/);
  assert.match(wtGit(l, "log", "--format=%b", "-1"), /Assisted-by: Cursor:deepseek-v41-flash-1017-high/);
  assert.equal(task(l).status, "done");
});

test("an agent that fails with no work leaves the task blocked and the sandbox deleted", async () => {
  const l = lab({ FAKE_BUILDER_MODE: "fail" });
  await withTask(l);
  assert.equal((await l.cli("builder", "start", "--task", "smoke-task", "--harness", "cursor", "--brief", l.brief)).code, 0);
  assert.equal(task(l).status, "blocked");
  assert.match(task(l).detail, /exited 3 with 0 commit\(s\) and set no status/);
  assert.deepEqual(JSON.parse(readFileSync(l.env.FAKE_OPENSHELL_STATE, "utf8")).sandboxes, []);
});

test("a firing oncebitten check blocks a task the agent marked done", async () => {
  const l = lab({ FAKE_ONCEBITTEN_CHECK: "1" });
  await withTask(l);
  assert.equal((await l.cli("builder", "start", "--task", "smoke-task", "--harness", "cursor", "--brief", l.brief)).code, 0);
  assert.equal(task(l).status, "blocked");
  assert.match(task(l).detail, /oncebitten check --base main fired: no-sleep-in-tests/);
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
  assert.equal((await l.cli("builder", "start", "--task", "smoke-task", "--harness", "opencode", "--brief", l.brief)).code, 1);
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

test("sharedLibs lists a binary's libraries without glibc's own", async () => {
  const libs = await sharedLibs(process.execPath);
  assert.ok(Array.isArray(libs));
  assert.ok(libs.every((p) => path.isAbsolute(p) && !/^(libc|libm|libdl|libpthread|librt|ld-linux)\./.test(path.basename(p))));
});
