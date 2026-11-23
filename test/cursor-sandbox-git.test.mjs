// The Cursor adapter's OpenShell round trip for a git work tree: a clone goes in, commits come back the way builders land them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cursorAdapter, { cursorPolicy, sandboxName } from "../runner/adapters/cursor.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CURSOR = path.join(HERE, "helpers", "fake-cursor-agent.mjs");
const OPENSHELL = path.join(HERE, "helpers", "fake-openshell.mjs");
chmodSync(CURSOR, 0o755);
chmodSync(OPENSHELL, 0o755);
const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...ID, ...args], { encoding: "utf8" }).trim();

function lab() {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-cursor-git-"));
  const root = path.join(home, "repo");
  const version = path.join(home, "cursor-agent", "versions", "2026.11.22-fake");
  for (const dir of [root, version]) mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--template=", "-b", "main", root]);
  writeFileSync(path.join(root, "host.txt"), "host\n");
  git(root, "add", "host.txt");
  git(root, "commit", "--quiet", "-m", "init");
  writeFileSync(path.join(version, "cursor-agent"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(path.join(version, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = {
    PATH: process.env.PATH, HOME: home, AI_COLLAB_CURSOR_BIN: CURSOR, AI_COLLAB_OPENSHELL_BIN: OPENSHELL, AI_COLLAB_CURSOR_TREE: version,
    FAKE_CURSOR_LOG: path.join(home, "cursor.log"), FAKE_OPENSHELL_LOG: path.join(home, "openshell.log"),
    FAKE_OPENSHELL_STATE: path.join(home, "openshell.json"), FAKE_SANDBOX_CURSOR_BIN: CURSOR,
  };
  return { home, root, version, env };
}

const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const ctx = () => ({ emit() {}, log() {}, signal: new AbortController().signal });
const open = (t) => cursorAdapter({ env: t.env }).open({
  project: "demo", cwd: t.root, place: "openshell", permissionMode: "full-access", permission: { force: true }, env: t.env,
}, ctx());

test("a git work tree goes in as a clone with its own .git, and its commits and edits land on the host branch", async () => {
  const t = lab();
  const handle = await open(t);
  const inside = path.join(path.dirname(t.env.FAKE_OPENSHELL_STATE), "sandboxes", sandboxName("demo"), "work", "repo");
  assert.ok(existsSync(path.join(inside, ".git", "HEAD")), "the sandbox gets a real repository, not the worktree's .git file");
  assert.equal(git(inside, "remote").trim(), "", "the clone keeps no remote to the host path");
  writeFileSync(path.join(inside, "committed.txt"), "one\n");
  git(inside, "add", "committed.txt");
  git(inside, "commit", "--quiet", "-m", "work inside");
  writeFileSync(path.join(inside, "loose.txt"), "two\n");
  await handle.close();
  assert.equal(git(t.root, "rev-list", "--count", "HEAD"), "3", "the inside commit and one commit of loose edits land");
  assert.equal(git(t.root, "log", "-1", "--format=%s"), "chore(openshell): uncommitted work from a sandboxed session");
  assert.equal(git(t.root, "status", "--porcelain"), "");
  assert.equal(readFileSync(path.join(t.root, "loose.txt"), "utf8"), "two\n");
});

test("a host branch that moved meanwhile is left alone", async () => {
  const t = lab();
  const handle = await open(t);
  const inside = path.join(path.dirname(t.env.FAKE_OPENSHELL_STATE), "sandboxes", sandboxName("demo"), "work", "repo");
  writeFileSync(path.join(inside, "inside.txt"), "x\n");
  writeFileSync(path.join(t.root, "host-only.txt"), "y\n");
  git(t.root, "add", "host-only.txt");
  git(t.root, "commit", "--quiet", "-m", "host moved");
  const before = git(t.root, "rev-parse", "HEAD");
  await handle.close();
  assert.equal(git(t.root, "rev-parse", "HEAD"), before);
});

test("the sandbox gets Cursor's API policy and the process-inspection switch when no policy is configured", async () => {
  const t = lab();
  const handle = await open(t);
  const calls = lines(t.env.FAKE_OPENSHELL_LOG);
  const create = calls.find((c) => c[1] === "create");
  const policy = JSON.parse(readFileSync(create[create.indexOf("--policy") + 1], "utf8"));
  assert.deepEqual(policy, cursorPolicy(t.version));
  assert.ok(policy.network_policies.cursor.endpoints.some((e) => e.host === "api2.cursor.sh"));
  assert.deepEqual(policy.network_policies.cursor.binaries.map((b) => b.path).sort(), ["/sandbox/agent/2026.11.22-fake/cursor-agent", "/sandbox/agent/2026.11.22-fake/node"]);
  const exec = calls.find((c) => c[1] === "exec" && c.includes("acp"));
  assert.ok(exec.includes("CURSOR_AGENT_ALLOW_PROCESS_INSPECTION=1"));
  await handle.close();
});
