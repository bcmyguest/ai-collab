import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionLabel } from "../lib/config.mjs";
import { claimParentNotice, listSessions, recordSession, sessionPlace, setIdentity, worktreeGone } from "../lib/sessions.mjs";
import { harnessCommand } from "../lib/controls.mjs";
import { interruptSession } from "../lib/interrupt.mjs";
import { scopeLaunch, scopeSupport } from "../lib/scope.mjs";
import { defaultStartPlace, startRefusal } from "../lib/start.mjs";

const UUID = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";
const DEAD = { pid: 4_194_000, start: "1" };
const self = () => {
  const text = readFileSync("/proc/self/stat", "utf8");
  return { pid: process.pid, start: text.slice(text.lastIndexOf(")") + 2).split(" ")[19] };
};

function fixture(id = UUID, peers = []) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "ai-collab-sessions-"));
  return { stateDir, project: "proj", peer: "claude", peers, session: sessionLabel(id), auto: false };
}

const registryDir = (cfg) => path.join(cfg.stateDir, cfg.project, "registry");

test("the registry entry keeps its file name and key set", async () => {
  const cfg = fixture();
  await recordSession(cfg, { id: UUID, cwd: "/tmp", harness: "claude", event: "SessionStart", proc: self(), model: "opus-4", name: "Title" });
  const address = `claude#${sessionLabel(UUID)}`;
  assert.deepEqual(readdirSync(registryDir(cfg)), [`${address}.json`]);
  const entry = JSON.parse(readFileSync(path.join(registryDir(cfg), `${address}.json`), "utf8"));
  assert.deepEqual(Object.keys(entry).sort(), ["cwd", "event", "harness", "id", "model", "name", "pid", "pidStart", "seenAt", "sessionId"]);
  assert.deepEqual([entry.id, entry.sessionId, entry.harness, entry.model, entry.name], [address, UUID, "claude", "opus-4", "Title"]);
});

test("online follows the recorded pid: this process online, a dead pid offline, none offline", async () => {
  const cfg = fixture();
  await recordSession(cfg, { id: UUID, cwd: "/tmp", harness: "claude", event: "SessionStart", proc: self() });
  const live = listSessions({ ...cfg, peers: [] }).find((s) => s.session === sessionLabel(UUID));
  assert.equal(live.online, true);
  await recordSession(cfg, { id: UUID, cwd: "/tmp", harness: "claude", event: "Stop", proc: DEAD });
  assert.equal(listSessions({ ...cfg, peers: [] })[0].online, false);
  await recordSession(cfg, { id: UUID, cwd: "/tmp", harness: "claude", event: "Stop" });
  assert.equal(listSessions({ ...cfg, peers: [] })[0].online, false);
});

test("set_identity validates its fields and needs a registered session", async () => {
  const cfg = fixture();
  await assert.rejects(setIdentity(cfg, { name: "PM" }), /not registered yet/);
  await recordSession(cfg, { id: UUID, cwd: "/tmp", harness: "claude", event: "SessionStart", proc: self() });
  await assert.rejects(setIdentity(cfg, { name: "bad/name" }), /name must be 1-40/);
  await assert.rejects(setIdentity(cfg, { activity: "x".repeat(201) }), /at most 200/);
  await assert.rejects(setIdentity(cfg, { tags: ["a b"] }), /tags: at most 10/);
  assert.deepEqual(await setIdentity(cfg, { activity: "  two   words  ", tags: ["role:reviewer"] }), { activity: "two words", tags: ["role:reviewer"] });
  const entry = JSON.parse(readFileSync(path.join(registryDir(cfg), `claude#${sessionLabel(UUID)}.json`), "utf8"));
  assert.deepEqual([entry.activity, entry.tags], ["two words", ["role:reviewer"]]);
});

test("the parent notice is claimed once and only after registration", async () => {
  const cfg = fixture();
  assert.equal(await claimParentNotice(cfg), false);
  await recordSession(cfg, { id: UUID, cwd: "/tmp", harness: "claude", event: "SessionStart", proc: self() });
  assert.equal(await claimParentNotice(cfg), true);
  assert.equal(await claimParentNotice(cfg), false);
});

test("harness commands: wake resumes by native id and cursor takes the binary found on PATH", () => {
  const [file, args] = harnessCommand("wake", "claude", UUID, false, { path: "" });
  assert.equal(file, "claude");
  assert.ok(args.includes(UUID));
  assert.equal(harnessCommand("unknown", "claude", UUID, false), null);
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai-collab-bin-"));
  writeFileSync(path.join(dir, "cursor-agent"), "#!/bin/sh\n");
  chmodSync(path.join(dir, "cursor-agent"), 0o755);
  assert.equal(harnessCommand("wake", "cursor", UUID, false, { path: dir })[0], "cursor-agent");
  writeFileSync(path.join(dir, "agent"), "#!/bin/sh\n");
  chmodSync(path.join(dir, "agent"), 0o755);
  assert.equal(harnessCommand("wake", "cursor", UUID, false, { path: dir })[0], "agent");
});

test("interrupt reports unsupported for claude and cursor, and routes codex through the injected daemon", async () => {
  const cwd = "/tmp";
  const peer = (harness, sessionId = UUID) => ({ harness, sessionId, cwd, id: `x#${sessionLabel(sessionId)}` });
  assert.equal((await interruptSession(null)).status, "unsupported");
  assert.equal((await interruptSession(peer("claude"))).status, "unsupported");
  assert.match((await interruptSession(peer("cursor"))).detail, /cursor has no outside interrupt/);
  const env = {};
  const interrupted = await interruptSession(peer("codex"), { env, runner: { kind: "host" }, codexInterrupt: async () => ({ status: "interrupted" }) });
  assert.equal(interrupted.status, "succeeded");
  const idle = await interruptSession(peer("codex"), { env, runner: { kind: "host" }, codexInterrupt: async () => ({ status: "not-running" }) });
  assert.equal(idle.status, "not-running");
  const detached = await interruptSession(peer("codex"), { env, runner: { kind: "host" }, codexInterrupt: async () => ({ status: "not-loaded" }) });
  assert.equal(detached.status, "unsupported");
  const opencodeId = "ses_" + "a".repeat(24);
  const ok = await interruptSession(peer("opencode", opencodeId), { opencode: async () => ({ ok: true, status: 200, body: { interrupted: true } }) });
  assert.equal(ok.status, "succeeded");
  const gone = await interruptSession(peer("opencode", opencodeId), { opencode: async () => ({ ok: false, status: 404 }) });
  assert.equal(gone.status, "not-running");
});

test("launch refusals name the unknown harness and mode", () => {
  assert.equal(startRefusal("nope"), "Unknown harness");
  assert.equal(startRefusal("claude", "no-such-mode"), "Unknown claude mode");
  assert.equal(startRefusal("claude", "agent", "bad model!"), "Unknown harness or model");
  assert.equal(startRefusal("claude", "agent", undefined), "");
});

test("start place falls back to folder when the preferred place is not offered", () => {
  assert.equal(defaultStartPlace(["folder"], "claude", {}), "folder");
  assert.equal(defaultStartPlace(["folder", "worktree"], "claude", {}), "folder");
});

test("scope falls back to a plain spawn without systemd-run, a user manager, or a systemd parent", () => {
  assert.deepEqual([scopeSupport({ env: {}, systemdRun: "" }).ok, scopeSupport({ env: {}, systemdRun: "" }).why], [false, "systemd-run is not installed"]);
  assert.equal(scopeSupport({ env: { DBUS_SESSION_BUS_ADDRESS: "x" }, systemdRun: "/bin/systemd-run" }).why, "not started by systemd, so no cgroup to leave");
  assert.equal(scopeSupport({ env: { AI_COLLAB_SCOPE: "off" }, systemdRun: "/bin/systemd-run" }).why, "AI_COLLAB_SCOPE=off");
  const plain = scopeLaunch(["claude", "-p"], { env: { AI_COLLAB_SCOPE: "off" }, path: "" });
  assert.deepEqual([plain.file, plain.args, plain.scoped, plain.unit], ["claude", ["-p"], false, ""]);
});

test("a session in a deleted worktree is gone; live or sandboxed ones are not", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ai-collab-wt-"));
  const gone = path.join(root, ".claude", "worktrees", "ai-collab-claude-1");
  assert.equal(worktreeGone({ cwd: gone, online: false }, root), true);
  assert.equal(worktreeGone({ cwd: gone, online: true }, root), false);
  assert.equal(worktreeGone({ cwd: gone, online: false, sandbox: true }, root), false);
  assert.equal(worktreeGone({ cwd: root, online: false }, root), false);
  assert.equal(sessionPlace({ cwd: root }, root), "folder");
  assert.equal(sessionPlace({ cwd: gone }, root), "worktree ai-collab-claude-1");
  assert.equal(sessionPlace({ cwd: "/x", sandbox: true }, root), "sandbox");
});
