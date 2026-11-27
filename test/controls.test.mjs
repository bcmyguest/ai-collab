import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { controlSession, harnessCommand, harnessEnv, runnerFromEnv } from "../lib/sessions/control.ts";
import { childEnv, resolveStartBinary } from "../lib/sessions/launch.ts";
import { sessionLabel } from "../lib/config.ts";
import { tempDir } from "./helpers/tmp.mjs";

const sessionId = "00000000-abcd-1234-9876-000000000001";
const selfStart = (() => { const s = readFileSync("/proc/self/stat", "utf8"); return s.slice(s.lastIndexOf(")") + 2).split(" ")[19]; })();
const exited = { pid: 4_194_000, pidStart: "1" };
const peer = { sessionId, cwd: "/tmp", id: "peer#" + sessionLabel(sessionId), ...exited };
const host = { runner: { kind: "host" } };

test("wake of an exited session resumes it once and permits retry after failure", async (t) => {
  process.env.AI_COLLAB_TOKEN = "secret";
  t.after(() => { delete process.env.AI_COLLAB_TOKEN; });
  for (const [harness, binary] of [["claude", "claude"], ["codex", "codex"], ["cursor", "agent"]]) {
    let calls = 0;
    const execute = async (file, args, { cwd, env }) => {
      assert.equal(file, binary);
      assert.ok(args.includes(sessionId));
      assert.equal(cwd, peer.cwd);
      // Only the wake marker crosses over; tokens and project settings never do.
      assert.deepEqual(Object.keys(env).filter(key => key.startsWith("AI_COLLAB_")), ["AI_COLLAB_WAKE"]);
      assert.equal(env.AI_COLLAB_WAKE, "1");
      return ++calls === 1 ? 1 : 0;
    };
    const wake = () => controlSession("wake", { ...peer, harness }, { ...host, execute });
    const first = wake();
    assert.equal(first, wake());
    assert.equal((await first).status, "failed");
    assert.equal((await wake()).status, "succeeded");
    assert.equal(calls, 2);
  }
});

test("the cursor wake command uses the Cursor binary on the given PATH", (t) => {
  const dir = tempDir(t, "ai-collab-cursor-");
  writeFileSync(path.join(dir, "cursor-agent"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(harnessCommand("wake", "cursor", sessionId, false, { path: dir })[0], "cursor-agent");
  writeFileSync(path.join(dir, "agent"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(harnessCommand("wake", "cursor", sessionId, false, { path: dir })[0], "agent");
});

test("start and wake run the Cursor binary cursorBinary finds on their own PATH", (t) => {
  const home = tempDir(t, "ai-collab-cursor-");
  const dir = path.join(home, "bin");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "agent"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(path.join(dir, "cursor-agent"), "#!/bin/sh\n", { mode: 0o755 });
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
  t.after(() => { process.env.PATH = saved.PATH; process.env.HOME = saved.HOME; });
  // HOME has no ~/.local/bin, so the only Cursor names on either PATH are in dir.
  process.env.PATH = dir;
  process.env.HOME = home;
  const started = () => resolveStartBinary("cursor", ["cursor-agent"], childEnv().PATH)[0];
  const woke = () => harnessCommand("wake", "cursor", sessionId, false, { path: harnessEnv().PATH })[0];
  assert.equal(started(), "agent");
  assert.equal(woke(), "agent", "wake matches start");
  rmSync(path.join(dir, "agent"));
  assert.equal(started(), "cursor-agent");
  assert.equal(woke(), "cursor-agent", "wake matches start once only cursor-agent is installed");
});

test("a running session, or a PID reused by another process, is never resumed", async () => {
  let calls = 0;
  const execute = async () => ++calls;
  const running = { ...peer, harness: "claude", pid: process.pid, pidStart: selfStart };
  assert.equal((await controlSession("wake", running, { ...host, execute })).status, "queued");
  assert.equal((await controlSession("compact", running, { ...host, execute })).status, "unsupported");
  const reused = { ...running, pidStart: "1" };
  assert.equal((await controlSession("wake", reused, { ...host, execute: async () => 0 })).status, "succeeded");
  assert.equal(calls, 0);
});

test("missing process records, unsupported actions, and bad IDs run no commands", async () => {
  let calls = 0;
  const execute = async () => ++calls;
  for (const [action, record] of [
    ["wake", { ...peer, harness: "claude", pid: undefined }],
    ["compact", { ...peer, harness: "cursor" }],
    ["wake", { ...peer, harness: "codex", sessionId: "--last" }],
  ]) {
    assert.equal((await controlSession(action, record, { ...host, execute })).status, "unsupported");
  }
  assert.equal(calls, 0);
});

test("claude compaction runs /compact through the Agent SDK and reports its boundary", async () => {
  const record = { ...peer, harness: "claude" };
  const compact = async (id, cwd) => {
    assert.equal(id, sessionId);
    assert.equal(cwd, "/tmp");
    return { boundary: { pre_tokens: 16005, post_tokens: 3569 }, result: "success" };
  };
  assert.deepEqual(await controlSession("compact", record, { ...host, compact }),
    { status: "succeeded", detail: "Compacted 16005 → 3569 tokens." });
  const none = async () => ({ boundary: null, result: "success" });
  assert.equal((await controlSession("compact", record, { ...host, compact: none })).status, "failed");
  const thrown = async () => { throw new Error("boom"); };
  assert.equal((await controlSession("compact", record, { ...host, compact: thrown })).status, "failed");
});

test("openshell runner wraps the harness command in sandbox exec", async () => {
  const runner = runnerFromEnv({ AI_COLLAB_WAKE_RUNNER: "openshell", AI_COLLAB_OPENSHELL_SANDBOX: "agents" });
  const execute = async (file, args) => {
    assert.equal(file, "openshell");
    assert.deepEqual(args.slice(0, 9), ["sandbox", "exec", "--name", "agents", "--workdir", "/tmp", "--no-tty", "--no-login-shell", "--"]);
    assert.deepEqual(args.slice(9, 12), ["claude", "--print", "--resume"]);
    return 0;
  };
  assert.equal((await controlSession("wake", { ...peer, harness: "claude" }, { runner, execute })).status, "succeeded");
  assert.equal(runnerFromEnv({ AI_COLLAB_WAKE_RUNNER: "openshell" }).kind, "invalid");
  assert.equal(runnerFromEnv({ AI_COLLAB_WAKE_RUNNER: "docker" }).kind, "invalid");
});

test("wake and compact on one session do not share results", async () => {
  let release;
  const execute = () => new Promise(r => { release = r; });
  const record = { ...peer, harness: "claude" };
  const wake = controlSession("wake", record, { ...host, execute });
  assert.equal((await controlSession("compact", record, { ...host, execute })).status, "failed");
  release(0);
  assert.equal((await wake).status, "succeeded");
});

test("codex compaction runs thread/compact/start over app-server for an exited session", async () => {
  const record = { ...peer, harness: "codex" };
  const codex = async (id, { cwd, env, command }) => {
    assert.equal(id, sessionId);
    assert.equal(cwd, "/tmp");
    assert.deepEqual(command, ["codex", ["app-server"]]);
    assert.ok(!Object.keys(env).some(key => key.startsWith("AI_COLLAB_")));
    return { compacted: true };
  };
  assert.deepEqual(await controlSession("compact", record, { ...host, codex }),
    { status: "succeeded", detail: "Codex compacted the thread." });
  const thrown = async () => { throw new Error("timed out"); };
  assert.equal((await controlSession("compact", record, { ...host, codex: thrown })).status, "failed");
  const running = { ...record, pid: process.pid, pidStart: selfStart };
  const codexLive = async () => ({ status: "not-loaded" });
  assert.equal((await controlSession("compact", running, { ...host, codex, codexLive })).status, "unsupported");
});
