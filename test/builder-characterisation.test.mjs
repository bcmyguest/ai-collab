// Characterisation: pins today's behaviour of the builder's public functions — argv built, files written,
// results — so the TypeScript port can change no observable output. Pure and hermetic: temp state dirs only.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  BUILDER_HARNESSES, builder, builderAssignment, builderId, builderPaths, builderPolicy, builderResumePrompt,
  builderSandbox, briefNotes, captureHooks, claudeMcpConfig, claudeSettings, harnessCommand, hostCaptureEvents,
  ownedBuilder, parseRecordedCall, replayable, stoppedBuilder,
} from "../lib/builder.mjs";
import { FINAL_PHASES, builderExited, readState, updateState, writeState } from "../lib/builder/state.mjs";
import { BUILDER_DIR_CAP, builderLiveRefusal, buildersToRemove, cleanBuilders, worktreeIsProtected } from "../lib/builder-clean.mjs";
import { PROMPT_MAX_CHARS } from "../lib/start.mjs";

const DEAD_PID = 0x7fffffef; // no process here can hold this pid; process.kill(pid, 0) says ESRCH

function tempEnv(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "builder-char-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, env: { HOME: dir, AI_COLLAB_STATE_DIR: path.join(dir, "state") } };
}

function sink() {
  const out = [];
  return { write: (s) => { out.push(String(s)); return true; }, text: () => out.join("") };
}

test("harnessCommand builds a flat string argv per harness and refuses unknown harnesses", () => {
  for (const harness of BUILDER_HARNESSES) {
    const argv = harnessCommand({ harness, model: "m", brief: "b", workdir: "/sandbox/work/w", launcher: undefined, builderCode: false });
    assert.ok(Array.isArray(argv) && argv.length > 1, `${harness} argv`);
    assert.ok(argv.every((part) => typeof part === "string"), `${harness} argv parts are strings`);
  }
  assert.throws(() => harnessCommand({ harness: "gemini", model: "m", brief: "b", workdir: "/w" }), /unknown harness gemini/);
});

test("builderPaths resolves unit, sandbox, worktree and state paths from env", (t) => {
  const { dir, env } = tempEnv(t);
  const paths = builderPaths("smoke-task", env);
  const state = path.join(dir, "state", "builders", "smoke-task");
  assert.deepEqual(paths, {
    unit: "builder-smoke-task",
    sandbox: builderSandbox("smoke-task"),
    worktree: path.join(dir, "ai-collab-wt-smoke-task"),
    dir: state, state: path.join(state, "state.json"), brief: path.join(state, "brief.md"),
    policy: path.join(state, "policy.yaml"), stage: path.join(state, "stage"), back: path.join(state, "back"), out: path.join(state, "out"),
  });
  const moved = builderPaths("smoke-task", { ...env, AI_COLLAB_BUILDER_WORKTREES: "/wt" });
  assert.equal(moved.worktree, "/wt/ai-collab-wt-smoke-task");
});

test("builderId sanitizes and builderSandbox stays within openshell's 19-char name limit", () => {
  assert.equal(builderId("Smoke_Task!!"), "smoke-task");
  assert.equal(builderId("-lead-"), "lead");
  assert.equal(builderId("x".repeat(80)).length, 63);
  const name = builderSandbox("some-long-builder-id-9999");
  assert.match(name, /^b-[a-z0-9-]+-[0-9a-f]{6}$/);
  assert.ok(name.length <= 17, name);
  assert.equal(name, builderSandbox("some-long-builder-id-9999"), "deterministic");
});

test("writeState and updateState write the state file; update merges and stamps updated", (t) => {
  const { env } = tempEnv(t);
  const paths = builderPaths("s1", env);
  mkdirSync(paths.dir, { recursive: true });
  writeState(paths, { phase: "starting", id: "s1" });
  assert.deepEqual(readState(paths), { phase: "starting", id: "s1" });
  updateState(paths, { phase: "running" });
  const state = readState(paths);
  assert.equal(state.id, "s1");
  assert.equal(state.phase, "running");
  assert.ok(Number.isSafeInteger(state.updated) && state.updated > 0, "updated stamped");
});

test("builderExited: final phases are exited; a live pid is not; a dead pid is", () => {
  for (const phase of FINAL_PHASES) assert.equal(builderExited({ phase, pid: process.pid }), true, phase);
  assert.equal(builderExited({ phase: "running", pid: process.pid }), false);
  assert.equal(builderExited({ phase: "running", pid: DEAD_PID }), true);
  assert.equal(builderExited({ phase: "running", owned: true, pid: DEAD_PID }), false, "owned waits for the runner");
});

test("briefNotes names the worktree, branch, task and the oncebitten gate", () => {
  const notes = briefNotes({ task: "t1", branch: "builder/x", workdir: "/sandbox/work/wt" });
  for (const needle of ["/sandbox/work/wt", "branch builder/x", "task show t1", "oncebitten check --base", "task set t1 status=done"]) {
    assert.ok(notes.includes(needle), `notes contain ${needle}`);
  }
});

test("builderResumePrompt keeps the instruction and truncates the prompt to the cap", () => {
  const prompt = builderResumePrompt("p".repeat(PROMPT_MAX_CHARS * 2));
  assert.ok(prompt.startsWith("The runner restarted during this assignment."));
  assert.ok(prompt.length <= PROMPT_MAX_CHARS, `length ${prompt.length}`);
  assert.ok(prompt.endsWith("p".repeat(prompt.length - prompt.indexOf("\n\n") - 2)), "the kept prompt is the truncated original");
});

test("parseRecordedCall splits NUL-terminated argv; replayable admits only task set and progress", () => {
  assert.deepEqual(parseRecordedCall("task\0set\0t1\0status=done\0"), ["task", "set", "t1", "status=done"]);
  assert.deepEqual(parseRecordedCall("task\0progress\0t1\0text"), ["task", "progress", "t1", "text"]);
  assert.equal(replayable(["task", "set", "t1", "status=done"]), true);
  assert.equal(replayable(["task", "progress", "t1", "note"]), true);
  assert.equal(replayable(["task", "show", "t1"]), false);
  assert.equal(replayable(["task", "set", "t1"]), false, "needs a value");
  assert.equal(replayable(["send", "all", "x", "y"]), false);
});

test("hostCaptureEvents keeps host capture hooks and falls back to the defaults", (t) => {
  const { dir } = tempEnv(t);
  const file = path.join(dir, "hooks.json");
  const defaults = ["beforeSubmitPrompt", "postToolUse", "postToolUseFailure"];
  writeFileSync(file, JSON.stringify({ hooks: {
    beforeSubmitPrompt: [{ command: "oncebitten capture cursor" }],
    postToolUse: [{ hooks: [{ type: "command", command: "/usr/local/bin/oncebitten capture cursor" }] }],
    stop: [{ command: "echo not-capture" }],
  } }));
  assert.deepEqual(hostCaptureEvents("cursor", file), ["beforeSubmitPrompt", "postToolUse"]);
  rmSync(file);
  assert.deepEqual(hostCaptureEvents("cursor", file), defaults, "missing file: defaults");
  writeFileSync(file, JSON.stringify({ hooks: {} }));
  assert.deepEqual(hostCaptureEvents("cursor", file), defaults, "no capture hooks: defaults");
});

test("claudeSettings, claudeMcpConfig and captureHooks keep their shapes", () => {
  const settings = claudeSettings(["UserPromptSubmit"]);
  assert.equal(settings.autoCompactEnabled, true);
  assert.equal(settings.autoCompactWindow, 250000);
  assert.ok(settings.permissions.deny.includes("WebFetch"));
  assert.ok(settings.permissions.deny.includes("mcp__ai-collab__task_list"));
  assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, "/sandbox/tools/bin/ob-capture claude");
  assert.deepEqual(claudeMcpConfig({ node: "", project: "p", codeMode: true }), { mcpServers: {} }, "no node: no servers");
  const mcp = claudeMcpConfig({ node: "/x/node", project: "p", codeMode: false });
  assert.deepEqual(Object.keys(mcp.mcpServers), ["ai-collab"]);
  assert.equal(mcp.mcpServers["ai-collab"].args[0], "/sandbox/tools/ai-collab/scripts/ai-collab-mcp.mjs");
  const hooks = captureHooks("cursor", ["postToolUse"]);
  assert.deepEqual(hooks, { version: 1, hooks: { postToolUse: [{ command: "/sandbox/tools/bin/ob-capture cursor" }] } });
});

test("builderPolicy keeps the filesystem and network shape per harness", () => {
  const policy = builderPolicy({ harness: "cursor", binaries: ["/sandbox/cursor/x"], ntfyBinaries: ["/sandbox/tools/node/bin/node"] });
  assert.equal(policy.version, 1);
  assert.equal(policy.filesystem_policy.include_workdir, true);
  assert.ok(policy.filesystem_policy.read_only.includes("/usr"));
  assert.ok(policy.filesystem_policy.read_write.includes("/sandbox"));
  const cursor = policy.network_policies.cursor;
  assert.equal(cursor.name, "cursor");
  assert.ok(cursor.endpoints.every((e) => e.tls === "skip"), "cursor keeps its own TLS");
  assert.deepEqual(cursor.binaries, [{ path: "/sandbox/cursor/x" }]);
  assert.deepEqual(policy.network_policies.ai_collab.endpoints, [{ host: "host.openshell.internal", port: 8794, protocol: "rest", access: "full" }]);
  const codex = builderPolicy({ harness: "codex", binaries: [] });
  assert.ok(codex.network_policies.codex.endpoints.every((e) => e.protocol === "rest" && e.access === "full"), "codex goes through the proxy");
});

test("buildersToRemove orders finished, failed, stopped by mtime then id, and keeps the rest", () => {
  const rows = [
    { id: "s1", phase: "stopped", mtime: 1 },
    { id: "f2", phase: "failed", mtime: 3 },
    { id: "f1", phase: "failed", mtime: 2 },
    { id: "z1", phase: "finished", mtime: 9 },
    { id: "a1", phase: "finished", mtime: 9 },
    { id: "r1", phase: "running", mtime: 0 },
  ];
  assert.deepEqual(buildersToRemove(rows, 6), [], "at the cap nothing goes");
  assert.deepEqual(buildersToRemove(rows, 4), ["a1", "z1"], "oldest finished first (tie: id)");
  assert.deepEqual(buildersToRemove(rows, 2), ["a1", "z1", "f1", "f2"], "then failed by mtime");
  assert.deepEqual(buildersToRemove(rows, 0), ["a1", "z1", "f1", "f2", "s1"], "running stays");
  assert.equal(BUILDER_DIR_CAP, 50);
});

test("worktreeIsProtected covers paths inside the repo root and the standing checkouts", () => {
  assert.equal(worktreeIsProtected("/home/b/ai-collab", "/home/b/ai-collab"), true, "the repo root itself");
  assert.equal(worktreeIsProtected("/home/b/ai-collab/lib", ""), true, "inside the repo root");
  assert.equal(worktreeIsProtected("/home/b/ai-collab-serving/wt", ""), true, "serving checkout");
  assert.equal(worktreeIsProtected("/home/b/ai-collab-wt-x", "/home/b/ai-collab"), false, "a sibling is not inside");
  assert.equal(worktreeIsProtected("/tmp/unrelated/wt", "/home/b/ai-collab"), false);
});

test("builderLiveRefusal refuses at the live cap and cleanBuilders removes oldest finished", async (t) => {
  const { dir, env } = tempEnv(t);
  const root = path.join(dir, "state", "builders");
  const put = (id, phase) => {
    const one = path.join(root, id);
    mkdirSync(one, { recursive: true });
    writeFileSync(path.join(one, "state.json"), JSON.stringify({ id, phase }));
  };
  assert.equal(builderLiveRefusal(env), "", "none live");
  put("run1", "running");
  put("run2", "staging");
  assert.equal(builderLiveRefusal(env), "2 builders are already running or staging (run1, run2)");
  put("fin1", "finished");
  put("fin2", "finished");
  const removed = await cleanBuilders(env, { cap: 3 });
  assert.deepEqual(removed, ["fin1"], "oldest finished removed; absent worktree counts as removed");
  assert.equal(builderLiveRefusal(env, 1), "1 builders are already running or staging (run1, run2)", "names every live id");
});

test("stoppedBuilder and builderAssignment read the state file and decide the handoff", (t) => {
  const { dir, env } = tempEnv(t);
  const task = { id: "t9", status: "building" };
  assert.equal(stoppedBuilder("demo", task, env), null, "no state file");
  const paths = builderPaths("t9", env);
  const worktree = path.join(dir, "wt");
  mkdirSync(path.join(worktree, ".git"), { recursive: true });
  const base = { id: "t9", task: "t9", project: "demo", harness: "codex", model: "m", phase: "finished", worktree, branch: "b", commits: 0, sandboxCreated: false, sandboxDeleted: true, unit: "builder-t9", sandbox: "b-t9-abc123" };
  assert.equal(stoppedBuilder("demo", task, env), null, "state file missing still null");
  writeState(paths, base);
  assert.equal(stoppedBuilder("demo", { ...task, status: "review" }, env), null, "review is not handed off");
  assert.deepEqual(stoppedBuilder("demo", task, env), base);
  assert.equal(stoppedBuilder("other", task, env), null, "other project");

  const assignment = builderAssignment("demo", task, [], env);
  assert.ok(assignment.recovery, "exited builder recovers");
  assert.equal(assignment.recovery.harness, "codex");
  assert.deepEqual(assignment.recovery.choices, ["cursor", "claude", "opencode"]);
  assert.equal(assignment.recovery.sandboxWorkspace, false);
  assert.equal(builderAssignment("demo", { ...task, status: "done" }, [], env), null);
  assert.equal(builderAssignment("demo", task, [{ taskId: "t9", status: "active" }], env), null, "a live session owns it");

  // A builder whose pid is alive and whose workspace is uploaded keeps its unit instead of recovering.
  updateState(paths, { phase: "running", pid: process.pid, owned: false, workspaceUploaded: true });
  assert.deepEqual(builderAssignment("demo", task, [], env), { builderUnit: "builder-t9" });
});

test("ownedBuilder admits only the matching codex owned builder", (t) => {
  const { env } = tempEnv(t);
  const paths = builderPaths("o1", env);
  mkdirSync(paths.dir, { recursive: true });
  assert.throws(() => ownedBuilder("demo", "not an id!", env), /Invalid builder id/);
  assert.throws(() => ownedBuilder("demo", "o1", env), /ENOENT/, "no state file");
  writeState(paths, { id: "o1", project: "demo", harness: "codex", owned: true, phase: "running" });
  assert.equal(ownedBuilder("demo", "o1", env).phase, "running");
  assert.throws(() => ownedBuilder("x", "o1", env), /Unknown owned builder/, "other project");
});

test("builder list prints owned rows only with --all and refuses bad subcommands", async (t) => {
  const { dir, env } = tempEnv(t);
  const one = path.join(dir, "state", "builders", "o1");
  mkdirSync(one, { recursive: true });
  writeFileSync(path.join(one, "state.json"), JSON.stringify({ id: "o1", owned: true, address: "codex#a", task: "t1", sandbox: "b-o1-abc123", phase: "finished", unit: "builder-o1" }));
  const hidden = sink();
  const all = sink();
  const err = sink();
  assert.equal(await builder(["list"], { env, cfg: {}, out: hidden, err }), 0);
  assert.equal(hidden.text(), "", "finished owned hidden");
  assert.equal(await builder(["list", "--all"], { env, cfg: {}, out: all, err }), 0);
  assert.equal(all.text(), "codex#a\tt1\tb-o1-abc123\tfinished\tfinished\n");
  assert.equal(await builder(["bogus"], { env, cfg: {}, out: all, err }), 1);
  assert.equal(await builder(["stop"], { env, cfg: {}, out: all, err }), 1);
  assert.match(err.text(), /usage: builder stop <id>/);
});
