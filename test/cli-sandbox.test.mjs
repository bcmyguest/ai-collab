// Claude and Codex in OpenShell against the fake openshell: staging, the sandboxed CLI argv, landing on close.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventType } from "@ag-ui/core";
import { createClaudeAdapter } from "../runner/adapters/claude.ts";
import codexAdapter from "../runner/adapters/codex.ts";
import { CLAUDE_IN, claudeSandboxEnv, codexInstall, createClaudeSandbox, createCodexSandbox } from "../runner/adapters/cli-sandbox.ts";
import { harnessSandboxName, opencodeSandboxName, sandboxName } from "../lib/sandbox.ts";
import { openshellHarnesses } from "../lib/sessions/launch.ts";
import { permissionSettings } from "../runner/contract.ts";
import { fakeClaudeQuery } from "./helpers/fake-claude-query.mjs";
import { fileEnd, tempDir } from "./helpers/tmp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPENSHELL = path.join(HERE, "helpers", "fake-openshell.mjs");
const APP_SERVER = path.join(HERE, "helpers", "fake-codex-app-server.mjs");
chmodSync(OPENSHELL, 0o755);
// A stand-in Claude Code CLI: prints its argv, cwd and the env it got, then exits.
const FAKE_CLAUDE = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }) + "\\n");
`;

// A host git worktree, a Claude and a Codex login, a fake Codex release tree, a fake Claude binary, and the fakes' env.
function lab() {
  const home = tempDir(fileEnd, "ai-collab-cli-sandbox-");
  const root = path.join(home, "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "host.txt"), "host\n");
  const git = (...args) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
  git("init", "--quiet", "-b", "main");
  git("add", "-A");
  git("commit", "--quiet", "-m", "init");
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  writeFileSync(path.join(home, ".claude", ".credentials.json"), '{"claude":"never-print-me"}\n', { mode: 0o600 });
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  writeFileSync(path.join(home, ".codex", "auth.json"), '{"codex":"never-print-me-either"}\n', { mode: 0o600 });
  const tree = path.join(home, "codex-release");
  mkdirSync(path.join(tree, "bin"), { recursive: true });
  writeFileSync(path.join(tree, "bin", "codex"), `#!/bin/sh\nexec "${process.execPath}" "${APP_SERVER}" "$@"\n`, { mode: 0o755 });
  const claude = path.join(home, "claude-2.1.0");
  writeFileSync(claude, FAKE_CLAUDE, { mode: 0o755 });
  const env = {
    PATH: process.env.PATH, HOME: home, AI_COLLAB_OPENSHELL_BIN: OPENSHELL, AI_COLLAB_CODEX_TREE: tree, AI_COLLAB_CLAUDE_BIN: claude,
    FAKE_OPENSHELL_LOG: path.join(home, "openshell.log"), FAKE_OPENSHELL_STATE: path.join(home, "openshell.json"), FAKE_CODEX_LOG: path.join(home, "codex.log"),
  };
  return { home, root, env, git };
}

const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const box = (t, name, ...rest) => path.join(t.home, "sandboxes", name, ...rest);
const sandboxes = (t) => (existsSync(t.env.FAKE_OPENSHELL_STATE) ? JSON.parse(readFileSync(t.env.FAKE_OPENSHELL_STATE, "utf8")).sandboxes : []);
const CLAUDE_BOX = harnessSandboxName("claude", "demo");
const CODEX_BOX = harnessSandboxName("codex", "demo");
const claudeOptions = (t, extra = {}) => ({ project: "demo", cwd: t.root, place: "openshell", permissionMode: "full-access", permission: permissionSettings("claude", "full-access", "openshell").settings, env: t.env, ...extra });
const codexOptions = (t, extra = {}) => ({ project: "demo", cwd: t.root, place: "openshell", permissionMode: "full-access", permission: permissionSettings("codex", "full-access", "openshell").settings, env: t.env, ...extra });

function ctx() {
  const events = [];
  const logs = [];
  return { events, logs, emit: (e) => events.push(e), log: (m) => logs.push(m), signal: new AbortController().signal };
}

async function until(check, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Runs the SDK's spawner the way the SDK does and returns what the sandboxed CLI printed.
function spawnThrough(spawner, sdkOptions) {
  const child = spawner(sdkOptions);
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { out += chunk; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}`))));
    child.stdin.end();
  });
}

test("every harness has its own runner sandbox name, and all four may start in OpenShell", () => {
  const names = ["claude", "codex", "cursor", "opencode"].map((h) => harnessSandboxName(h, "demo"));
  assert.deepEqual(names.slice(2), [sandboxName("demo"), opencodeSandboxName("demo")]);
  assert.equal(new Set(names).size, 4);
  for (const h of ["claude", "codex"]) assert.ok(harnessSandboxName(h, "a-very-long-project-name").length <= 19);
  assert.deepEqual(openshellHarnesses({ PATH: process.env.PATH }), ["claude", "codex", "cursor", "opencode"]);
});

test("Claude offers OpenShell only with a sandbox; Codex stages its own only without a command override", () => {
  assert.equal(createClaudeAdapter({ query: fakeClaudeQuery().query }).capabilities.places, undefined);
  assert.deepEqual(createClaudeAdapter({ query: fakeClaudeQuery().query, sandbox: createClaudeSandbox({ env: {} }) }).capabilities.places, ["folder", "worktree", "openshell"]);
  assert.equal(codexAdapter({ env: {} }).capabilities.openshellStarts, true);
  assert.equal(codexAdapter({ command: { file: "x", args: [] } }).capabilities.openshellStarts, false);
});

test("claudeSandboxEnv keeps the SDK's own variables, drops host paths and secrets, and points HOME at the sandbox", () => {
  const env = claudeSandboxEnv({
    PATH: "/usr/bin", HOME: "/home/x", CLAUDE_CODE_ENTRYPOINT: "sdk-ts", CLAUDE_AGENT_SDK_VERSION: "0.3", CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k",
    AI_COLLAB_OWNED: "claude", AI_COLLAB_PARENT: "abc", AI_COLLAB_MANAGED: "1", AI_COLLAB_TOKEN: "s",
  });
  assert.deepEqual(Object.keys(env).sort(), [
    "AI_COLLAB_MANAGED", "AI_COLLAB_OWNED", "AI_COLLAB_PARENT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_ENTRYPOINT",
    "DISABLE_AUTOUPDATER", "DISABLE_ERROR_REPORTING", "DISABLE_TELEMETRY", "HOME", "TMPDIR", "XDG_CONFIG_HOME",
  ]);
  assert.equal(env.HOME, "/sandbox/home");
});

test("codexInstall names the release tree's launcher inside the sandbox and every binary for the policy", () => {
  const t = lab();
  const inst = codexInstall(t.env);
  assert.equal(inst.local, t.env.AI_COLLAB_CODEX_TREE);
  assert.equal(inst.bin, "/sandbox/codex/codex-release/bin/codex");
  assert.deepEqual(inst.binaries, ["/sandbox/codex/codex-release/bin/codex"]);
  assert.throws(() => codexInstall({ PATH: "", AI_COLLAB_CODEX_TREE: t.home }), /AI_COLLAB_CODEX_TREE/);
});

test("a Claude OpenShell session runs the CLI in the sandbox, and its close lands the work and deletes the sandbox", async () => {
  const t = lab();
  const fake = fakeClaudeQuery();
  const c = ctx();
  const adapter = createClaudeAdapter({ query: fake.query, sandbox: createClaudeSandbox({ env: t.env }) });
  const handle = await adapter.open(claudeOptions(t), c);

  const [created] = sandboxes(t);
  assert.equal(created.name, CLAUDE_BOX);
  assert.equal(created.labels["ai-collab.owner"], "claude-demo");
  assert.ok(existsSync(box(t, CLAUDE_BOX, "work", "repo", ".git")), "the worktree is uploaded as a git clone");
  assert.ok(existsSync(box(t, CLAUDE_BOX, "claude", "claude")), "the binary is installed at /sandbox/claude/claude");
  assert.equal(readFileSync(box(t, CLAUDE_BOX, "home", ".claude", ".credentials.json"), "utf8"), '{"claude":"never-print-me"}\n');
  assert.equal(existsSync(box(t, CLAUDE_BOX, "home", ".codex")), false, "only Claude's login goes in");

  const { options } = fake.queries[0];
  assert.equal(options.cwd, "/sandbox/work/repo");
  assert.equal(options.permissionMode, "bypassPermissions");
  assert.equal(options.pathToClaudeCodeExecutable, CLAUDE_IN);
  const printed = await spawnThrough(options.spawnClaudeCodeProcess, {
    command: "/host/claude", args: ["--output-format", "stream-json"], cwd: options.cwd,
    env: { ...options.env, CLAUDE_CODE_ENTRYPOINT: "sdk-ts", ANTHROPIC_API_KEY: "never-in-argv" }, signal: new AbortController().signal,
  });
  assert.deepEqual(printed.argv, ["--output-format", "stream-json"]);
  assert.equal(printed.cwd, box(t, CLAUDE_BOX, "work", "repo"), "the CLI runs in the sandbox's copy");
  assert.equal(printed.env.HOME, box(t, CLAUDE_BOX, "home"));
  assert.equal(printed.env.AI_COLLAB_OWNED, "claude");
  assert.equal(printed.env.CLAUDE_CODE_ENTRYPOINT, "sdk-ts");
  const exec = lines(t.env.FAKE_OPENSHELL_LOG).find((a) => a[1] === "exec" && a.includes("stream-json"));
  assert.ok(exec.includes("--no-tty"));
  const argv = readFileSync(t.env.FAKE_OPENSHELL_LOG, "utf8");
  assert.ok(!argv.includes("never-in-argv") && !argv.includes("never-print-me"), "no secret reaches argv");
  assert.ok(!argv.includes(t.home + "/repo\""), "no host worktree path reaches the CLI argv");

  writeFileSync(box(t, CLAUDE_BOX, "work", "repo", "made-inside.txt"), "from the sandbox\n");
  await handle.close();
  assert.equal(fake.queries[0].closed, true);
  assert.equal(readFileSync(path.join(t.root, "made-inside.txt"), "utf8"), "from the sandbox\n", "the edit lands on the host");
  assert.match(t.git("log", "-1", "--format=%B"), /Assisted-by: Claude:claude-code/);
  assert.deepEqual(sandboxes(t), [], "the sandbox is deleted");
});

test("a Claude folder session keeps the host CLI and no spawner", async () => {
  const t = lab();
  const fake = fakeClaudeQuery();
  const adapter = createClaudeAdapter({ query: fake.query, sandbox: createClaudeSandbox({ env: t.env }) });
  const handle = await adapter.open(claudeOptions(t, { place: "folder" }), ctx());
  assert.equal(fake.queries[0].options.cwd, t.root);
  assert.equal(fake.queries[0].options.spawnClaudeCodeProcess, undefined);
  assert.equal(existsSync(t.env.FAKE_OPENSHELL_LOG), false);
  await handle.close();
});

test("a failed Claude handshake in OpenShell releases the sandbox", async () => {
  const t = lab();
  const adapter = createClaudeAdapter({ query: fakeClaudeQuery({ failInit: "no login" }).query, sandbox: createClaudeSandbox({ env: t.env }) });
  await assert.rejects(adapter.open(claudeOptions(t), ctx()), /no login/);
  assert.deepEqual(sandboxes(t), []);
});

test("a restored Claude record resumes in the kept sandbox without a new upload, and its close lands the work", async () => {
  const t = lab();
  const before = createClaudeAdapter({ query: fakeClaudeQuery().query, sandbox: createClaudeSandbox({ env: t.env }) });
  await before.open(claudeOptions(t), ctx());
  writeFileSync(box(t, CLAUDE_BOX, "work", "repo", "made-inside.txt"), "kept\n");
  await before.shutdown();
  assert.ok(sandboxes(t).some((s) => s.name === CLAUDE_BOX), "shutdown keeps the sandbox");

  const record = { address: "claude#abc", project: "demo", cwd: t.root, place: "openshell", status: "idle", nativeId: "n1", permissionMode: "full-access" };
  const fake = fakeClaudeQuery();
  const resumedAdapter = createClaudeAdapter({ query: fake.query, sandbox: createClaudeSandbox({ env: t.env }) });
  resumedAdapter.restore(record);
  const handle = await resumedAdapter.resume(record, ctx(), t.env);
  assert.equal(fake.queries[0].options.resume, "n1");
  assert.equal(fake.queries[0].options.cwd, "/sandbox/work/repo");
  assert.equal(readFileSync(box(t, CLAUDE_BOX, "work", "repo", "made-inside.txt"), "utf8"), "kept\n", "the sandbox's work is not overwritten");
  await handle.close();
  assert.equal(readFileSync(path.join(t.root, "made-inside.txt"), "utf8"), "kept\n");
  assert.deepEqual(sandboxes(t), []);
});

test("a plain Codex OpenShell start runs the uploaded app-server in the sandbox and lands its work on close", async () => {
  const t = lab();
  const c = ctx();
  const adapter = codexAdapter({ env: t.env });
  try {
    const handle = await adapter.open(codexOptions(t), c);
    const [created] = sandboxes(t);
    assert.equal(created.name, CODEX_BOX);
    assert.equal(created.labels["ai-collab.owner"], "codex-demo");
    assert.ok(existsSync(box(t, CODEX_BOX, "codex", "codex-release", "bin", "codex")), "the release tree is uploaded");
    assert.equal(readFileSync(box(t, CODEX_BOX, "home", ".codex", "auth.json"), "utf8"), '{"codex":"never-print-me-either"}\n');
    assert.equal(existsSync(box(t, CODEX_BOX, "home", ".claude")), false, "only Codex's login goes in");

    const [start] = lines(t.env.FAKE_CODEX_LOG).filter((e) => e.kind === "start");
    assert.deepEqual(start.argv, ["app-server", "-c", "thread_unload_delay_secs=0"]);
    assert.equal(start.owned, "codex");
    const [thread] = lines(t.env.FAKE_CODEX_LOG).filter((e) => e.kind === "request" && e.method === "thread/start");
    assert.equal(thread.params.cwd, "/sandbox/work/repo");
    assert.equal(thread.params.approvalPolicy, "never");
    assert.equal(thread.params.sandbox, "danger-full-access");
    const exec = lines(t.env.FAKE_OPENSHELL_LOG).find((a) => a[1] === "exec" && a.includes("app-server"));
    assert.ok(exec.includes("CODEX_HOME=/sandbox/home/.codex"));
    assert.ok(!readFileSync(t.env.FAKE_OPENSHELL_LOG, "utf8").includes("never-print-me-either"), "the login never reaches argv");

    const { runId } = await handle.send({ text: "hello" });
    await until(() => c.events.find((e) => e.type === EventType.RUN_FINISHED && e.runId === runId), "the run to finish");
    writeFileSync(box(t, CODEX_BOX, "work", "repo", "made-inside.txt"), "from codex\n");
    await handle.close();
    assert.equal(readFileSync(path.join(t.root, "made-inside.txt"), "utf8"), "from codex\n");
    assert.match(t.git("log", "-1", "--format=%B"), /Assisted-by: Codex:codex/);
    assert.deepEqual(sandboxes(t), []);
  } finally {
    await adapter.shutdown();
  }
});

test("a managed Codex OpenShell start runs without native subagents and with the managed marker", async () => {
  const t = lab();
  const adapter = codexAdapter({ env: t.env });
  try {
    const handle = await adapter.open(codexOptions(t, { managed: true }), ctx());
    const exec = lines(t.env.FAKE_OPENSHELL_LOG).find((a) => a[1] === "exec" && a.includes("app-server"));
    assert.ok(exec.includes("AI_COLLAB_MANAGED=1"));
    const [start] = lines(t.env.FAKE_CODEX_LOG).filter((e) => e.kind === "start");
    assert.ok(start.argv.length > 3, "the no-subagent args follow the app-server args");
    await handle.close();
  } finally {
    await adapter.shutdown();
  }
});

test("Claude and Codex sessions of one project use apart sandboxes; a restored Codex record is released and landed", async () => {
  const t = lab();
  const claude = createClaudeAdapter({ query: fakeClaudeQuery().query, sandbox: createClaudeSandbox({ env: t.env }) });
  const codex = codexAdapter({ env: t.env, sandbox: createCodexSandbox({ env: t.env }) });
  try {
    const a = await claude.open(claudeOptions(t), ctx());
    await codex.open(codexOptions(t), ctx());
    assert.deepEqual(sandboxes(t).map((s) => s.name).sort(), [CLAUDE_BOX, CODEX_BOX].sort());
    await a.close();
    assert.deepEqual(sandboxes(t).map((s) => s.name), [CODEX_BOX], "closing Claude's session leaves Codex's sandbox");
    writeFileSync(box(t, CODEX_BOX, "work", "repo", "released.txt"), "released\n");
    await codex.shutdown();
    const record = { address: "codex#def", project: "demo", cwd: t.root, place: "openshell", status: "idle" };
    const restarted = codexAdapter({ env: t.env });
    restarted.restore(record);
    assert.equal(await restarted.release(record), true);
    assert.equal(readFileSync(path.join(t.root, "released.txt"), "utf8"), "released\n");
    assert.deepEqual(sandboxes(t), []);
  } finally {
    await codex.shutdown();
  }
});
