// Native code mode setting (lib/code-mode.mjs): default on, defaults.json, per start, team.dot roles, and what each harness gets.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_CODE_MODE_KEY, claudeCodeModeSettings, codeModeDefault, codexCodeModeArgs, parseCodeMode, resolveCodeMode } from "../lib/code-mode.mjs";
import { loadConfig } from "../lib/config.mjs";
import { parseDot, serializeDot } from "../lib/catalog/dot.ts";
import { checkTeamText } from "../lib/patterns.mjs";
import { startRun } from "../lib/pattern-runs.mjs";
import { startCommand } from "../lib/start.mjs";
import { projectTeamsDir, teamFilePath } from "../lib/catalog/team-files.ts";
import { createClaudeAdapter } from "../runner/adapters/claude.mjs";
import codexAdapter, { APP_SERVER_ARGS } from "../runner/adapters/codex.mjs";
import { createFakeAdapter } from "../runner/adapters/fake.mjs";
import { permissionSettings } from "../runner/contract.mjs";
import { readOwned } from "../lib/owned.mjs";
import { codeModeField } from "../web/lib/new-session.js";
import { fakeClaudeQuery } from "./helpers/fake-claude-query.mjs";
import { wrapOpen } from "./helpers/fake-adapter-hooks.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { makeRunner, setup } from "./helpers/runner-ctx.mjs";
import { sessionLabel } from "../lib/config.mjs";

const FAKE_CODEX = fileURLToPath(new URL("./helpers/fake-codex-app-server.mjs", import.meta.url));
const MODELS = { claude: ["claude-haiku-5-5"], codex: ["gpt-5"], cursor: ["deepseek-v41-flash-1017-high"] };

function configHome(t, defaults) {
  const home = mkdtempSync(join(tmpdir(), "ai-collab-code-mode-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".config", "ai-collab"), { recursive: true });
  if (defaults) writeFileSync(join(home, ".config", "ai-collab", "defaults.json"), JSON.stringify(defaults));
  return { HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
}

const ctxFor = () => ({ events: [], emit(e) { this.events.push(e); }, log: () => {}, signal: new AbortController().signal });

test("code mode defaults on, defaults.json codeMode sets it globally, and a start's own value wins", (t) => {
  assert.equal(codeModeDefault(configHome(t)), true);
  const off = configHome(t, { codeMode: false });
  assert.equal(codeModeDefault(off), false);
  assert.equal(codeModeDefault(configHome(t, { codeMode: "off" })), false);
  assert.equal(codeModeDefault(configHome(t, { codeMode: "maybe" })), true, "an unparsable value keeps the default");
  assert.equal(resolveCodeMode(undefined, off), false);
  assert.equal(resolveCodeMode(true, off), true);
  assert.equal(resolveCodeMode("on", off), true);
  assert.deepEqual([parseCodeMode("ON"), parseCodeMode("0"), parseCodeMode(""), parseCodeMode(null)], [true, false, undefined, undefined]);
});

test("each harness gets its own switch: Claude flag settings, Codex features.code_mode", () => {
  assert.deepEqual(claudeCodeModeSettings(true), { env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "1" } });
  assert.deepEqual(claudeCodeModeSettings(false), { env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "0" } });
  assert.deepEqual(codexCodeModeArgs(true), ["-c", "features.code_mode=true"]);
  assert.equal(CODEX_CODE_MODE_KEY, "features.code_mode");
  assert.deepEqual(startCommand("codex", "/r", "hi", { codeMode: true }), ["codex", ["exec", "--json", "--dangerously-bypass-hook-trust", "-c", "features.code_mode=true", "hi"]]);
  assert.deepEqual(startCommand("codex", "/r", "hi", { codeMode: false, mode: "plan" }), ["codex", ["exec", "--json", "--dangerously-bypass-hook-trust", "-c", "features.code_mode=false", "-s", "read-only", "hi"]]);
  // Claude --bg refuses code mode, so its UI start argv is unchanged; Cursor and OpenCode have no native mode.
  assert.deepEqual(startCommand("claude", "/r", "hi", { codeMode: true }), startCommand("claude", "/r", "hi"));
  assert.deepEqual(startCommand("cursor", "/r", "hi", { codeMode: true }), startCommand("cursor", "/r", "hi"));
  assert.deepEqual(startCommand("opencode", "/r", "hi", { codeMode: true }), startCommand("opencode", "/r", "hi"));
});

test("the new-session composer sends codeMode only for a harness whose start can use it", () => {
  assert.deepEqual(codeModeField("codex", true), { codeMode: true });
  assert.deepEqual(codeModeField("codex", false), { codeMode: false });
  assert.deepEqual(codeModeField("claude", true), { codeMode: true });
  assert.deepEqual(codeModeField("claude", true, "plan"), {});
  assert.deepEqual(codeModeField("claude", true, "agent", "openshell"), {});
  assert.deepEqual(codeModeField("cursor", true), {});
});

test("the Claude adapter passes code mode as SDK flag settings on open and resume, and nothing when unknown", async () => {
  const fake = fakeClaudeQuery();
  const adapter = createClaudeAdapter({ query: fake.query, handshakeMs: 1000 });
  const base = { cwd: "/work", permission: { permissionMode: "default" }, env: {} };
  const on = await adapter.open({ ...base, codeMode: true }, ctxFor());
  const off = await adapter.open({ ...base, codeMode: false }, ctxFor());
  const unknown = await adapter.open(base, ctxFor());
  const resumed = await adapter.resume({ nativeId: "n-1", cwd: "/work", permissionMode: "supervised", place: "folder", codeMode: true }, ctxFor(), {});
  assert.deepEqual(fake.queries[0].options.settings, { env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "1" } });
  assert.deepEqual(fake.queries[1].options.settings, { env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "0" } });
  assert.equal(fake.queries[2].options.settings, undefined);
  assert.deepEqual(fake.queries[3].options.settings, { env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "1" } });
  for (const handle of [on, off, unknown, resumed]) await handle.close();
});

test("the Codex adapter sends features.code_mode in thread/start and thread/resume config", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ai-collab-code-mode-codex-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logFile = join(dir, "fake.log");
  const adapter = codexAdapter({ command: { file: process.execPath, args: [FAKE_CODEX, ...APP_SERVER_ARGS], version: [FAKE_CODEX, "--version"] } });
  const rollout = join(dir, "rollout.jsonl");
  writeFileSync(rollout, JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", call_id: "old", name: "exec", input: "old call" } }) + "\n");
  const env = { ...process.env, FAKE_CODEX_LOG: logFile, FAKE_CODEX_ROLLOUT: rollout };
  const requests = (method) => readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "request" && e.method === method);
  try {
    const options = (codeMode) => ({ project: "p", cwd: "/tmp", place: "folder", permissionMode: "auto", permission: permissionSettings("codex", "auto", "folder").settings, env, ...(codeMode === undefined ? {} : { codeMode }) });
    const run = async (open) => {
      const events = [];
      const finished = Promise.withResolvers();
      const handle = await open({ ...ctxFor(), emit(event) {
        events.push(event);
        if (event.type === "RUN_FINISHED") finished.resolve();
      } });
      await handle.send({ text: "compute with code mode" });
      await finished.promise;
      assert.deepEqual(events.map(event => event.type), ["RUN_STARTED", "TOOL_CALL_CHUNK", "TOOL_CALL_RESULT", "RUN_FINISHED"]);
      assert.equal(events[1].toolCallName, "exec");
      assert.equal(events[1].delta, "text(17 * 19)");
      assert.equal(events[2].toolCallId, events[1].toolCallId);
      assert.equal(events[2].content, "323");
    };
    await run(ctx => adapter.open(options(true), ctx));
    await adapter.open(options(undefined), ctxFor());
    await run(ctx => adapter.resume({ nativeId: "thr-9", address: `codex#${sessionLabel("thr-9")}`, cwd: "/tmp", place: "folder", permissionMode: "auto", codeMode: false }, ctx, env));
    const starts = requests("thread/start");
    assert.deepEqual(starts[0].params.config, { "features.code_mode": true });
    assert.equal(starts[0].params.experimentalRawEvents, true);
    assert.equal(starts[1].params.config, undefined, "an unknown setting sends no override");
    assert.deepEqual(requests("thread/resume")[0].params.config, { "features.code_mode": false });
  } finally {
    await adapter.shutdown();
  }
});

test("the runner resolves code mode per start, records it, and hands it to the adapter", async () => {
  const fake = await startFakeNtfy();
  const ctx = setup(fake);
  const opened = [];
  const adapter = wrapOpen(createFakeAdapter({ harness: "claude" }), (options, context, baseOpen) => { opened.push(options.codeMode); return baseOpen(options, context); });
  const { runner } = makeRunner(ctx, [adapter], { watch: false });
  await runner.boot();
  try {
    const first = await runner.start({ project: "demo", harness: "claude", prompt: "hello" });
    const second = await runner.start({ project: "demo", harness: "claude", prompt: "hello", codeMode: false });
    writeFileSync(join(ctx.home, ".config", "ai-collab", "defaults.json"), JSON.stringify({ codeMode: false }));
    await runner.start({ project: "demo", harness: "claude", prompt: "hello" });
    assert.deepEqual(opened, [true, false, false]);
    assert.equal(readOwned(ctx.cfg, sessionLabel(first.nativeId)).codeMode, true);
    assert.equal(readOwned(ctx.cfg, sessionLabel(second.nativeId)).codeMode, false);
    await assert.rejects(runner.start({ project: "demo", harness: "claude", prompt: "hello", codeMode: "sometimes" }), /codeMode must be on or off/);
  } finally {
    await runner.stop();
    await fake.close();
  }
});

const TEAM = `digraph "duo" {
  "lead" [agent="codex", prompt="Scope it.", code_mode="off"];
  "doer" [agent="claude", prompt="Do it.", code_mode=on];
  "lead" -> "doer" [on="scope"];
  "doer" -> "done" [on="finished"];
}`;

test("team.dot code_mode=on|off parses, round-trips, rejects other values, and reaches the role's start", async (t) => {
  const team = parseDot(TEAM);
  assert.deepEqual(team.nodes.map((n) => n.codeMode), [false, true]);
  assert.deepEqual(parseDot(serializeDot(team)).nodes.map((n) => n.codeMode), [false, true]);
  assert.match(serializeDot(team), /code_mode="off"/);
  assert.throws(() => parseDot(TEAM.replace('code_mode="off"', 'code_mode="auto"')), /code_mode must be on or off/);
  assert.equal(parseDot(TEAM.replace(', code_mode="off"', "")).nodes[0].codeMode, undefined);

  const env = configHome(t);
  const root = join(env.HOME, "repo");
  mkdirSync(root);
  writeFileSync(join(env.XDG_CONFIG_HOME, "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo", url: "http://127.0.0.1:9", peers: "claude,codex,cursor" }]));
  Object.assign(env, { AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "operator", AI_COLLAB_PEERS: "claude,codex,cursor", AI_COLLAB_URL: "http://127.0.0.1:9" });
  const cfg = loadConfig(env);
  const checked = checkTeamText(cfg, "duo", TEAM);
  assert.equal(checked.ok, true, checked.error);
  assert.deepEqual(checked.pattern.roles.map((r) => r.codeMode), [false, true]);
  const file = teamFilePath(projectTeamsDir(root), "duo");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, TEAM);
  const starts = [];
  await startRun(cfg, "duo", "ship it", env, { start: async (_cfg, options) => { starts.push(options); return { status: "started", session: "codex#0123456789abcdef" }; }, models: MODELS });
  assert.equal(starts[0].harness, "codex");
  assert.equal(starts[0].codeMode, false);
  assert.ok(existsSync(file));
});
