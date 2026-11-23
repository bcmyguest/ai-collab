// Claude and Codex logins reach runner OpenShell sessions and sandboxed ticks as builders copy them: 0600, never in argv or logs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cursorAdapter, { sandboxName } from "../runner/adapters/cursor.mjs";
import { harnessLogins } from "../runner/sandbox.mjs";
import { sandboxRun } from "../runner/sandbox-run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CURSOR = path.join(HERE, "helpers", "fake-cursor-agent.mjs");
const OPENSHELL = path.join(HERE, "helpers", "fake-openshell.mjs");
chmodSync(CURSOR, 0o755);
chmodSync(OPENSHELL, 0o755);
const CLAUDE_SECRET = '{"claudeAiOauth":"claude-never-print-me"}';
const CODEX_SECRET = '{"tokens":"codex-never-print-me"}';

function lab() {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-logins-"));
  const repo = path.join(home, "repo");
  const tree = path.join(home, "cursor-agent", "versions", "2026.11.22-fake");
  for (const dir of [repo, tree, path.join(home, ".claude"), path.join(home, ".codex"), path.join(home, ".config", "ai-collab")]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(home, ".claude", ".credentials.json"), CLAUDE_SECRET, { mode: 0o600 });
  writeFileSync(path.join(home, ".codex", "auth.json"), CODEX_SECRET, { mode: 0o600 });
  execFileSync("git", ["init", "--quiet", "--template=", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "init"]);
  writeFileSync(path.join(tree, "cursor-agent"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const node = path.join(home, "fake-node");
  writeFileSync(node, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, "data"), AI_COLLAB_STATE_DIR: path.join(home, "state"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"), CODEX_HOME: path.join(home, ".codex"),
    AI_COLLAB_CURSOR_BIN: CURSOR, AI_COLLAB_OPENSHELL_BIN: OPENSHELL, AI_COLLAB_CURSOR_TREE: tree, FAKE_SANDBOX_CURSOR_BIN: CURSOR,
    AI_COLLAB_BUILDER_NODE: node, AI_COLLAB_BUILDER_NODE_MODULES: "none", AI_COLLAB_BUILDER_GIT: "none", AI_COLLAB_BUILDER_GIT_CORE: "none", AI_COLLAB_BUILDER_ONCEBITTEN: "none",
    FAKE_CURSOR_LOG: path.join(home, "cursor.log"), FAKE_OPENSHELL_LOG: path.join(home, "openshell.log"), FAKE_OPENSHELL_STATE: path.join(home, "openshell.json"),
  };
  return { home, repo, env };
}

// The two login files in a fake sandbox's home, checked for content and mode.
function assertLogins(box) {
  for (const [file, secret] of [[path.join(box, "home", ".claude", ".credentials.json"), CLAUDE_SECRET], [path.join(box, "home", ".codex", "auth.json"), CODEX_SECRET]]) {
    assert.equal(readFileSync(file, "utf8"), secret, file);
    assert.equal(statSync(file).mode & 0o077, 0, `${file} stays private`);
  }
}

test("harnessLogins finds the files builders copy, from CLAUDE_CONFIG_DIR and CODEX_HOME", () => {
  const { home, env } = lab();
  assert.deepEqual(harnessLogins(env, home), [
    { harness: "claude", file: path.join(home, ".claude", ".credentials.json"), remoteDir: "/sandbox/home/.claude" },
    { harness: "codex", file: path.join(home, ".codex", "auth.json"), remoteDir: "/sandbox/home/.codex" },
  ]);
  assert.deepEqual(harnessLogins({ HOME: "/nonexistent" }, "/nonexistent").filter((l) => l.file.startsWith("/nonexistent")), []);
});

test("a runner OpenShell session gets the Claude and Codex logins; no secret reaches argv or a log", async () => {
  const t = lab();
  const logs = [];
  const handle = await cursorAdapter({ env: t.env }).open({
    project: "demo", cwd: t.repo, place: "openshell", permissionMode: "full-access", permission: { force: true }, env: t.env, home: t.home,
  }, { emit() {}, log: (m) => logs.push(m), signal: new AbortController().signal });
  assertLogins(path.join(t.home, "sandboxes", sandboxName("demo")));
  await handle.close();
  const argv = readFileSync(t.env.FAKE_OPENSHELL_LOG, "utf8");
  for (const secret of ["claude-never-print-me", "codex-never-print-me"]) {
    assert.ok(!argv.includes(secret));
    assert.ok(!logs.join("\n").includes(secret));
  }
});

test("a sandboxed tick gets the Claude and Codex logins", async () => {
  const t = lab();
  const logs = [];
  const agent = path.join(t.home, "fake-agent");
  writeFileSync(agent, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const code = await sandboxRun({ name: "tick", cwd: t.repo, command: ["cursor-agent", "-p", "x"] }, { env: { ...t.env, FAKE_SANDBOX_CURSOR_BIN: agent }, log: (line) => logs.push(line), stdout: { write() {} }, stderr: { write() {} } });
  assert.equal(code, 0, logs.join("\n"));
  const box = readdirSync(path.join(t.home, "sandboxes")).find((name) => name.startsWith("s-tick-"));
  assertLogins(path.join(t.home, "sandboxes", box));
  assert.ok(!readFileSync(t.env.FAKE_OPENSHELL_LOG, "utf8").includes("never-print-me"));
  assert.ok(existsSync(path.join(t.home, "sandboxes", box, "home", ".claude")));
});
