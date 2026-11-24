import { parseWireEnvelope } from "../lib/agui.mjs";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig } from "../lib/config.mjs";
import { claimInbox, sendMessage } from "../lib/inbox.mjs";
import { currentMode, currentModeKnown, latestMode, operatorConfigs, parseMode, projectMode, publishMode, storedMode, takeModeNote } from "../lib/mode.mjs";
import { runCli } from "../lib/cli.mjs";

const ALL = "ai-collab-demo--to--all";
const mode = (m, ts, extra = {}) => JSON.stringify({ v: 1, kind: "mode", from: "operator", mode: m, ts, ...extra });

test("mode envelope parsing accepts only the fixed contract", () => {
  assert.deepEqual(parseMode(mode("on", 5)), { mode: "on", ts: 5 });
  assert.deepEqual(parseMode(mode("quiet", 5)), { mode: "quiet", ts: 5 });
  assert.equal(parseMode(mode("away", 5)), null);
  assert.equal(parseMode(mode("on", "5")), null);
  assert.equal(parseMode(mode("on", 5, { from: "claude" })), null);
  assert.equal(parseMode(mode("on", 5, { v: 2 })), null);
  assert.equal(parseMode(JSON.stringify({ v: 1, kind: "msg", from: "operator", mode: "on", ts: 5 })), null);
  assert.equal(parseMode("afk on"), null);
});

test("latest ts wins regardless of order; ties go to the later event", () => {
  const events = [mode("on", 300), mode("quiet", 100), mode("off", 300)].map((message, i) => ({ id: `e${i}`, message }));
  assert.deepEqual(latestMode(events), { mode: "off", ts: 300 });
  assert.equal(latestMode([{ id: "x", message: "hello" }]), null);
});

test("no envelope means off; claimInbox records the mode and never delivers it as chat", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const cfg = loadConfig(peerEnv(fake, { peer: "alice", AI_COLLAB_SESSION: "aabbccddeeff0123" }));
  assert.deepEqual(storedMode(cfg), { mode: "off", ts: 0 });
  assert.deepEqual(await currentMode(cfg), { mode: "off", ts: 0 });

  const now = Date.now();
  fake.inject(ALL, mode("on", now));
  fake.inject(ALL, mode("quiet", now - 1000)); // older ts, published later: ignored
  const operator = loadConfig(peerEnv(fake, { peer: "operator" }));
  await sendMessage(operator, "all", "@alice hello agents");
  const messages = await claimInbox(cfg);
  assert.deepEqual(messages.map((m) => m.body), ["@alice hello agents"]);
  assert.deepEqual(storedMode(cfg), { mode: "on", ts: now });
});

test("a new session learns the current mode at start from the cached broadcast history", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  fake.inject(ALL, mode("quiet", 1000));
  const cfg = loadConfig(peerEnv(fake, { peer: "bob", AI_COLLAB_SESSION: "0011223344556677" }));
  assert.deepEqual(await currentMode(cfg), { mode: "quiet", ts: 1000 });
  assert.equal(fake.state.polls.at(-1).since, "12h");
  assert.deepEqual(storedMode(cfg), { mode: "quiet", ts: 1000 });
});

test("a failed read is unknown, not off; the project's last good read stands in for it", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const stateDir = mkdtempSync(join(tmpdir(), "ai-collab-mode-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const state = (session) => loadConfig(peerEnv(fake, { peer: "alice", AI_COLLAB_SESSION: session, stateDir }));
  const first = state("aabbccddeeff0123");
  // Nothing has read the topic yet: a failed read cannot say off, because it does not know.
  fake.state.limitNext = 1;
  assert.equal(await currentModeKnown(first), null);
  assert.equal(storedMode(first).mode, "off", "the local read still defaults to off for callers that need a mode");
  assert.equal(await takeModeNote(first, { force: true }), "", "unknown is not announced as off");
  assert.equal(projectMode(first), null, "a failed read records nothing");

  // One good read records the project's mode, and a headless session with a failed read inherits it.
  fake.inject(ALL, mode("on", Date.now()));
  const good = await currentModeKnown(first);
  assert.equal(good.mode, "on");
  fake.state.limitNext = 1;
  const headless = state("0102030405060708");
  assert.deepEqual(await currentModeKnown(headless), good);
  assert.equal(storedMode(headless).mode, "on", "no network needed once this machine has read it");
  assert.match(await takeModeNote(headless, { force: true }), /AFK mode is ON/);
});

test("the mode note is announced once per change, and always when forced", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const cfg = loadConfig(peerEnv(fake, { peer: "alice", AI_COLLAB_SESSION: "aabbccddeeff0123" }));
  assert.equal(await takeModeNote(cfg), "", "default off needs no announcement");
  // Nothing has read the topic yet, so no mode is known: unknown is not announced as off.
  assert.equal(await takeModeNote(cfg, { force: true }), "");
  // SessionStart reads the topic before it forces the note; a read with no envelope is a read of off.
  assert.deepEqual(await currentMode(cfg), { mode: "off", ts: 0 });
  assert.match(await takeModeNote(cfg, { force: true }), /AFK mode is OFF/);
  fake.inject(ALL, mode("on", Date.now()));
  await claimInbox(cfg);
  const note = await takeModeNote(cfg);
  assert.match(note, /AFK mode is ON/);
  assert.match(note, /send_to_all tool \(progress=true, session="aabbccddeeff0123"\)/);
  assert.match(note, /up to 10 min/);
  assert.equal(await takeModeNote(cfg), "");
  fake.inject(ALL, mode("quiet", Date.now() + 1));
  await claimInbox(cfg);
  const quiet = await takeModeNote(cfg);
  assert.match(quiet, /QUIET: send no progress messages/);
});

test("publishMode and `ai-collab afk` reach every project in projects.json", async (t) => {
  const fake = await startFakeNtfy({ token: "fixture-only" });
  const root = mkdtempSync(join(tmpdir(), "ai-collab-mode-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); return fake.close(); });
  mkdirSync(join(root, "ai-collab"));
  const tokenFile = join(root, "token");
  writeFileSync(tokenFile, "fixture-only");
  writeFileSync(join(root, "ai-collab", "projects.json"), JSON.stringify([
    { root: join(root, "one"), project: "one", url: fake.url, tokenFile },
    { root: join(root, "two"), project: "two", url: fake.url, tokenFile },
    { root: join(root, "two", "nested"), project: "two", url: fake.url, tokenFile },
  ]));
  const env = { XDG_CONFIG_HOME: root, XDG_STATE_HOME: root, PATH: process.env.PATH };
  const cfgs = operatorConfigs(env);
  assert.deepEqual(cfgs.map((c) => [c.project, c.peer]), [["one", "operator"], ["two", "operator"]]);

  assert.deepEqual(await publishMode(cfgs, "on", { now: 42 }), [{ project: "one", ok: true }, { project: "two", ok: true }]);
  assert.deepEqual(fake.state.publishes.map((p) => [p.topic, parseWireEnvelope(p.message)]), [
    ["ai-collab-one--to--all", { v: 1, kind: "mode", from: "operator", mode: "on", ts: 42 }],
    ["ai-collab-two--to--all", { v: 1, kind: "mode", from: "operator", mode: "on", ts: 42 }],
  ]);
  await assert.rejects(publishMode(cfgs, "away"), /mode must be one of/);

  let out = "";
  let err = "";
  const io = { env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, now: () => 43 };
  assert.equal(await runCli(["afk", "quiet"], io), 0, err);
  assert.equal(out, "afk quiet: one\nafk quiet: two\n");
  out = "";
  assert.equal(await runCli(["afk"], io), 0, err);
  assert.equal(out, "one\tquiet\ntwo\tquiet\n");
  assert.equal(await runCli(["afk", "maybe"], io), 1);
  assert.match(err, /usage: afk on\|off\|quiet/);
  // A read this machine cannot make says so; printing off would claim the operator is at the terminal.
  fake.state.limitNext = 2;
  out = "";
  assert.equal(await runCli(["afk"], { ...io, env: { ...env, XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "ai-collab-mode-empty-")) } }), 0, err);
  assert.equal(out, "one\tunknown\ntwo\tunknown\n");
});

test("afk park publishes off only when Space is pressed and restores the terminal", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "operator" });
  const cfg = loadConfig(env);
  fake.inject(ALL, mode("on", 1000));
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (raw) => { stdin.isRaw = raw; };
  const stdout = { isTTY: true, write() {} };
  const io = { env, stdin, stdout, now: () => 2000 };

  const cancelled = runCli(["afk", "park"], io);
  stdin.write("x");
  stdin.write("\x03");
  assert.equal(await cancelled, 130);
  assert.equal(stdin.isRaw, false);
  assert.equal((await currentMode(cfg)).mode, "on");

  const switched = runCli(["afk", "park"], io);
  assert.equal(stdin.isRaw, true);
  stdin.write(" ");
  assert.equal(await switched, 0);
  assert.equal(stdin.isRaw, false);
  assert.equal(stdin.listenerCount("data"), 0);
  assert.equal((await currentMode(cfg)).mode, "off");
});
