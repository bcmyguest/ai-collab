import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { claudeTarget } from "../lib/claude-socket.mjs";
import { processStart } from "../lib/process.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const SESSION_ID = "382cfeea-e0fb-45b2-b729-6b13b118f48f";
const PID = process.pid;

// A Claude home whose record carries recCwd as the launch cwd, and a live socket path.
async function fakeClaude(t, { recCwd, socketDir }) {
  const home = tempDir({ after }, "rc-home-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(join(home, "settings.json"), JSON.stringify({ crossSessionInbound: "accept" }));
  const socket = join(socketDir, "s.sock");
  const server = createServer();
  await new Promise((resolve) => server.listen(socket, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  writeFileSync(join(home, "sessions", `${PID}.json`), JSON.stringify({ pid: PID, sessionId: SESSION_ID, cwd: recCwd, messagingSocketPath: socket }));
  writeFileSync(join(home, "sessions", `${PID}.abc.key`), "tok\n");
  return home;
}

test("the transcript and project gate follow the record cwd, not the registry cwd", async (t) => {
  const sockDir = tempDir({ after }, "rc-sock-");
  t.after(() => rmSync(sockDir, { recursive: true, force: true }));
  const recCwd = "/home/b/ai-collab";
  const home = await fakeClaude(t, { recCwd, socketDir: sockDir });
  const session = { harness: "claude", sessionId: SESSION_ID, pid: PID, pidStart: processStart(PID), cwd: "/home/b/ai-collab/.claude/worktrees/agui" };
  const target = claudeTarget(session, { env: { CLAUDE_CONFIG_DIR: home } });
  assert.equal(target.transcript, join(home, "projects", "-home-b-ai-collab", `${SESSION_ID}.jsonl`));
});

test("a transcript that is not under the record cwd project is found by its session id", async (t) => {
  const sockDir = tempDir({ after }, "rc-sock-");
  t.after(() => rmSync(sockDir, { recursive: true, force: true }));
  const home = await fakeClaude(t, { recCwd: "/home/b/ai-collab", socketDir: sockDir });
  const elsewhere = join(home, "projects", "-somewhere-else");
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, `${SESSION_ID}.jsonl`), "{}\n");
  const session = { harness: "claude", sessionId: SESSION_ID, pid: PID, pidStart: processStart(PID), cwd: "/tmp" };
  const target = claudeTarget(session, { env: { CLAUDE_CONFIG_DIR: home } });
  assert.equal(target.transcript, join(elsewhere, `${SESSION_ID}.jsonl`));
});
