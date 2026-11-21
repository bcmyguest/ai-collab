import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeTarget, deliverToClaude } from "../lib/claude-socket.mjs";
import { processStart } from "../lib/process.mjs";
import { fakeClaudeHome, fakeClaudeSocket } from "./helpers/fake-claude.mjs";

const SESSION_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const TEXT = '- URGENT id=m00000001 from=bob to=claude#9967cd5f18178d07 at=2026-11-21T00:00:00Z body="ping"';

// The registry entry for this test process, as the dispatcher reads it.
function sessionFor(cwd, overrides = {}) {
  return { harness: "claude", sessionId: SESSION_ID, pid: process.pid, pidStart: processStart(process.pid), cwd, ...overrides };
}

// Env pointing Claude's config dir at the fake home, with a short confirmation window.
function envFor(home, ms = "800") {
  return { HOME: home, AI_COLLAB_CLAUDE_CONFIRM_MS: ms };
}

test("a message is delivered when the transcript shows it after the write", async (t) => {
  const sock = await fakeClaudeSocket(t);
  const claude = fakeClaudeHome(t, { sessionId: SESSION_ID, socket: sock.path });
  sock.state.transcript = claude.transcript;
  const ok = await deliverToClaude(sessionFor(claude.cwd), { text: TEXT, urgent: true, ids: ["m00000001"] }, { env: envFor(claude.home, "3000") });
  assert.equal(ok, true);
  assert.equal(sock.frames[0].priority, "next");
});

test("a refused message is not confirmed, so the caller leaves it for the hooks", async (t) => {
  const sock = await fakeClaudeSocket(t, { accept: false });
  const claude = fakeClaudeHome(t, { sessionId: SESSION_ID, socket: sock.path });
  sock.state.transcript = claude.transcript;
  const ok = await deliverToClaude(sessionFor(claude.cwd), { text: TEXT, ids: ["m00000001"] }, { env: envFor(claude.home, "300") });
  assert.equal(ok, false);
  assert.equal(sock.frames.length, 1, "the frame was written, so only the transcript check fails");
});

test("a wrong peer token is dropped by the socket and the message is not delivered", async (t) => {
  const sock = await fakeClaudeSocket(t, { token: "other-token" });
  const claude = fakeClaudeHome(t, { sessionId: SESSION_ID, socket: sock.path, token: "tok-123" });
  sock.state.transcript = claude.transcript;
  const ok = await deliverToClaude(sessionFor(claude.cwd), { text: TEXT, ids: ["m00000001"] }, { env: envFor(claude.home, "300") });
  assert.equal(ok, false);
  assert.equal(sock.dropped.length, 1);
  assert.equal(sock.frames.length, 0);
});

test("no token file, or two of them, gives no target", async (t) => {
  const sock = await fakeClaudeSocket(t);
  const none = fakeClaudeHome(t, { sessionId: SESSION_ID, socket: sock.path, token: null });
  assert.equal(claudeTarget(sessionFor(none.cwd), { env: { HOME: none.home } }), null);
  const two = fakeClaudeHome(t, { sessionId: SESSION_ID, socket: sock.path, extraKeys: ["second"] });
  assert.equal(claudeTarget(sessionFor(two.cwd), { env: { HOME: two.home } }), null);
});

test("a project setting that is not accept closes the gate", async (t) => {
  const sock = await fakeClaudeSocket(t);
  for (const [file, text] of [[".claude/settings.json", '{"crossSessionInbound":"hold"}'], [".claude/settings.local.json", '{"crossSessionInbound":"refuse"}'], [".claude/settings.json", "{ not json"]]) {
    const claude = fakeClaudeHome(t, { sessionId: SESSION_ID, socket: sock.path });
    const path = join(claude.cwd, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    assert.equal(claudeTarget(sessionFor(claude.cwd), { env: { HOME: claude.home } }), null, `${file} ${text}`);
  }
});

test("an unparsable user settings file closes the gate", async (t) => {
  const sock = await fakeClaudeSocket(t);
  const claude = fakeClaudeHome(t, { sessionId: SESSION_ID, socket: sock.path });
  writeFileSync(join(claude.home, ".claude", "settings.json"), "{ broken");
  assert.equal(claudeTarget(sessionFor(claude.cwd), { env: { HOME: claude.home } }), null);
});

test("a start tick that differs from the process gives no target (pid reuse)", async (t) => {
  const sock = await fakeClaudeSocket(t);
  const claude = fakeClaudeHome(t, { sessionId: SESSION_ID, socket: sock.path });
  assert.equal(claudeTarget(sessionFor(claude.cwd, { pidStart: "1" }), { env: { HOME: claude.home } }), null);
  assert.equal(claudeTarget(sessionFor(claude.cwd, { pidStart: undefined }), { env: { HOME: claude.home } }), null);
});

test("a symlinked session record gives no target", async (t) => {
  const sock = await fakeClaudeSocket(t);
  const claude = fakeClaudeHome(t, { sessionId: SESSION_ID, socket: sock.path });
  const record = join(claude.home, ".claude", "sessions", `${process.pid}.json`);
  const copy = `${record}.copy`;
  writeFileSync(copy, readFileSync(record, "utf8"));
  unlinkSync(record);
  symlinkSync(copy, record);
  assert.equal(claudeTarget(sessionFor(claude.cwd), { env: { HOME: claude.home } }), null);
});

test("a symlinked socket path gives no target", async (t) => {
  const sock = await fakeClaudeSocket(t);
  const claude = fakeClaudeHome(t, { sessionId: SESSION_ID, socket: `${sock.path}.link` });
  symlinkSync(sock.path, `${sock.path}.link`);
  assert.equal(claudeTarget(sessionFor(claude.cwd), { env: { HOME: claude.home } }), null);
});
