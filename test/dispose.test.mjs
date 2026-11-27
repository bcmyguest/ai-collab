import assert from "node:assert/strict";
import { test, after } from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionLabel } from "../lib/config.ts";
import { disposeSession, sessionPlace } from "../lib/sessions.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const self = () => {
  const text = readFileSync("/proc/self/stat", "utf8");
  return { pid: process.pid, start: text.slice(text.lastIndexOf(")") + 2).split(" ")[19] };
};

// A registry with one entry per session id; running ones record this process.
function setup(t, sessions) {
  const stateDir = tempDir({ after }, "ai-collab-dispose-");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const cfg = { stateDir, project: "demo", peers: [] };
  mkdirSync(path.join(stateDir, "demo", "registry"), { recursive: true });
  const files = Object.entries(sessions).map(([sessionId, running]) => {
    const id = `claude#${sessionLabel(sessionId)}`;
    const file = path.join(stateDir, "demo", "registry", id + ".json");
    writeFileSync(file, JSON.stringify({ id, sessionId, cwd: "/tmp", ...(running ? { pid: self().pid, pidStart: self().start } : { pid: 2 ** 22 + 1, pidStart: "1" }) }));
    return { id, file };
  });
  return { cfg, files };
}

test("dispose deletes an offline session's registry file", (t) => {
  const { cfg, files: [offline] } = setup(t, { off: false });
  disposeSession(cfg, offline.id);
  assert.equal(existsSync(offline.file), false);
});

test("dispose refuses a running session and keeps its file", (t) => {
  const { cfg, files: [running] } = setup(t, { on: true });
  assert.throws(() => disposeSession(cfg, running.id), { status: 409 });
  assert.equal(existsSync(running.file), true);
});

test("dispose refuses bad addresses and unknown sessions", (t) => {
  const { cfg, files: [offline] } = setup(t, { off: false });
  for (const bad of ["../x", "claude#../../x", "claude#abc", `claude#${"a".repeat(16)}/..`, "", undefined, 5]) {
    assert.throws(() => disposeSession(cfg, bad), { status: 400 }, String(bad));
  }
  assert.throws(() => disposeSession(cfg, "claude#" + "0".repeat(16)), { status: 404 });
  assert.equal(existsSync(offline.file), true);
});

test("sessionPlace names the folder, worktree, sandbox, or shortened path", () => {
  const root = "/work/demo";
  assert.equal(sessionPlace({ cwd: root }, root), "folder");
  assert.equal(sessionPlace({ cwd: `${root}/.claude/worktrees/ai-collab-codex-1` }, root), "worktree ai-collab-codex-1");
  assert.equal(sessionPlace({ cwd: `${root}/.claude/worktrees/a/sub` }, root), "worktree a");
  assert.equal(sessionPlace({ cwd: "/elsewhere/.claude/worktrees/feat" }, root), "worktree feat");
  assert.equal(sessionPlace({ cwd: root, sandbox: "box" }, root), "sandbox");
  assert.equal(sessionPlace({ cwd: path.join(os.homedir(), "code/x") }, root), "~/code/x");
  assert.equal(sessionPlace({ cwd: "/srv/x" }, root), "/srv/x");
  assert.equal(sessionPlace({}, root), "");
});
