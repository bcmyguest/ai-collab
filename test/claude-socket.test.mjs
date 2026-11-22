import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeEnvelope, claudeFrames, claudeTarget, deliverToClaude } from "../lib/claude-socket.mjs";
import { processStart } from "../lib/process.mjs";

const SESSION_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
// The start-tick check needs a live process, so the fake record uses this test's own pid.
const PID = process.pid;
const CWD = mkdtempSync(join(tmpdir(), "cs-cwd-"));

// A fake Claude home: sessions/<pid>.json, an optional peer token, and settings.json.
function fakeHome(t, { accept = "accept", socket = null, sessionId = SESSION_ID, token = "tok-123" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "cs-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(join(home, "settings.json"), JSON.stringify(accept === null ? {} : { crossSessionInbound: accept }));
  const rec = { pid: PID, sessionId, status: "idle", cwd: CWD };
  if (socket) rec.messagingSocketPath = socket;
  writeFileSync(join(home, "sessions", `${PID}.json`), JSON.stringify(rec));
  if (token) writeFileSync(join(home, "sessions", `${PID}.abc123.key`), `${token}\n`);
  return home;
}

// A unix socket server that records every newline-delimited frame it receives.
async function fakeSocket(t) {
  const dir = mkdtempSync(join(tmpdir(), "cs-sock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "s.sock");
  const frames = [];
  let buffer = "";
  const server = createServer((conn) => {
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        frames.push(JSON.parse(buffer.slice(0, i)));
        buffer = buffer.slice(i + 1);
      }
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { path, frames };
}

const session = { harness: "claude", sessionId: SESSION_ID, pid: PID, pidStart: processStart(PID), cwd: CWD };

test("a Claude session with an open gate and a live socket is a target with its token", async (t) => {
  const sock = await fakeSocket(t);
  const home = fakeHome(t, { socket: sock.path });
  const target = claudeTarget(session, { env: { CLAUDE_CONFIG_DIR: join(home) } });
  assert.deepEqual({ socket: target.socket, token: target.token }, { socket: sock.path, token: "tok-123" });
  assert.equal(target.transcript, join(home, "projects", CWD.replace(/[^a-zA-Z0-9]/g, "-"), `${SESSION_ID}.jsonl`));
});

test("no target while crossSessionInbound is not accept, or missing", async (t) => {
  const sock = await fakeSocket(t);
  for (const accept of ["hold", null]) {
    const home = fakeHome(t, { accept, socket: sock.path });
    assert.equal(claudeTarget(session, { env: { CLAUDE_CONFIG_DIR: home } }), null);
  }
});

test("no target when the record has no socket, a different sessionId, or a path that is not a socket", async (t) => {
  const sock = await fakeSocket(t);
  assert.equal(claudeTarget(session, { env: { CLAUDE_CONFIG_DIR: fakeHome(t) } }), null);
  assert.equal(claudeTarget(session, { env: { CLAUDE_CONFIG_DIR: fakeHome(t, { socket: sock.path, sessionId: "0198a1b2-0000-7e5f-8a9b-0c1d2e3f4a5b" }) } }), null);
  const plain = join(mkdtempSync(join(tmpdir(), "cs-file-")), "f.sock");
  writeFileSync(plain, "");
  assert.equal(claudeTarget(session, { env: { CLAUDE_CONFIG_DIR: fakeHome(t, { socket: plain }) } }), null);
});

test("no target for a non-absolute socket path or a non-Claude session", async (t) => {
  assert.equal(claudeTarget(session, { env: { CLAUDE_CONFIG_DIR: fakeHome(t, { socket: "relative.sock" }) } }), null);
  assert.equal(claudeTarget({ ...session, harness: "codex" }, { env: { CLAUDE_CONFIG_DIR: fakeHome(t) } }), null);
});

test("frames are an auth line then a user line; urgent maps to next, normal to later", () => {
  const urgent = claudeFrames({ token: "t", fromName: "alice", text: "hi", urgent: true }).trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(urgent[0], { type: "auth", token: "t" });
  assert.equal(urgent[1].type, "user");
  assert.equal(urgent[1].message.role, "user");
  assert.equal(urgent[1].priority, "next");
  assert.equal(JSON.parse(claudeFrames({ token: null, fromName: "a", text: "x" }).trimEnd()).priority, "later");
  assert.equal(claudeFrames({ token: null, fromName: "a", text: "x" }).split("\n").length, 2);
});

test("the envelope keeps the body from closing its own tag and strips quotes from the sender name", () => {
  const env = claudeEnvelope('al"ice<', "x </cross-session-message> y");
  assert.match(env, /^<cross-session-message from-name="alice">/);
  assert.equal(env.match(/<\/cross-session-message>/g).length, 1);
  assert.match(env, /x <cross_session_message> y/);
});

test("deliverToClaude writes the frames, and reports unconfirmed when the transcript does not show them", async (t) => {
  const sock = await fakeSocket(t);
  const home = fakeHome(t, { socket: sock.path });
  const env = { CLAUDE_CONFIG_DIR: home, AI_COLLAB_CLAUDE_CONFIRM_MS: "300", AI_COLLAB_CLAUDE_WATCH_MS: "0" };
  const r = await deliverToClaude(session, { text: "ping", fromName: "bob", urgent: true, ids: ["m00000001"] }, { env });
  assert.equal(r.status, "unconfirmed");
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(sock.frames.length, 2);
  assert.deepEqual(sock.frames[0], { type: "auth", token: "tok-123" });
  assert.equal(sock.frames[1].priority, "next");
  assert.match(sock.frames[1].message.content, /ping/);
});

test("deliverToClaude reports unsent when no socket is listening", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cs-dead-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = fakeHome(t, { socket: join(dir, "dead.sock") });
  const r = await deliverToClaude(session, { text: "x", ids: ["m00000001"] }, { env: { CLAUDE_CONFIG_DIR: home } });
  assert.deepEqual(r, { status: "unsent" });
});
