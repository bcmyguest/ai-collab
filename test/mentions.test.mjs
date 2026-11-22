import { parseWireEnvelope } from "../lib/agui.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { claimInbox } from "../lib/inbox.mjs";
import { recordSession } from "../lib/sessions.mjs";
import { createUi, mentionedNames, startOnlyMentions } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const base = "http://127.0.0.1:8795";

test("mentionedNames finds @harness and @session tags of the project's peers", () => {
  const codex = "codex#0123456789abcdef";
  assert.deepEqual(mentionedNames(`@codex and @${codex}, not a@claude or @all or @mallory`, ["claude", "codex"]), ["codex", codex]);
});

test("startOnlyMentions is true only for a post whose every tag starts a session", () => {
  const peers = ["claude", "codex"];
  assert.equal(startOnlyMentions("@codex:gpt-5-codex do X", peers), true);
  assert.equal(startOnlyMentions("@codex:gpt-5-codex and @claude:haiku split it", peers), true);
  assert.equal(startOnlyMentions("@codex:gpt-5-codex", peers), true);
  assert.equal(startOnlyMentions("@codex:gpt-5-codex look", peers, ["light-team"]), true);
  // Anyone running, or a tag that is not a model start, keeps the post a message.
  assert.equal(startOnlyMentions("@codex check this", peers), false);
  assert.equal(startOnlyMentions("@codex:gpt-5-codex and @claude look", peers), false);
  assert.equal(startOnlyMentions("no tags at all", peers), false);
  assert.equal(startOnlyMentions("@mallory:model do X", peers), false);
  // A tagged team starts a run and must keep the post a broadcast.
  assert.equal(startOnlyMentions("@light-team:codex do X", peers, ["light-team"]), false);
});

test("an @harness post reaches its running session, or starts one with the post as prompt", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-mention-"));
  const bin = path.join(home, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "codex"), "#!/bin/sh\n");
  chmodSync(path.join(bin, "codex"), 0o755);
  const stateDir = path.join(home, "state");
  const env = { ...peerEnv(fake, { peer: "operator", stateDir, AI_COLLAB_PEERS: "claude,codex" }), HOME: home, PATH: bin + path.delimiter + process.env.PATH };
  const cfg = loadConfig(env);
  const claude = { ...loadConfig({ ...env, AI_COLLAB_PEER: "claude" }), session: sessionLabel("c1") };
  await recordSession(claude, { id: "c1", cwd: home, harness: "claude", event: "SessionStart" });
  const target = `claude#${claude.session}`;
  const starts = [];
  const ui = createUi({ cfg, env, start: async (_cfg, options) => { starts.push(options); return { status: "starting" }; } });
  t.after(() => ui.close());
  const send = (body) => ui.handle(new Request(`${base}/api/send`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ target, body }),
  }), "send").then(r => r.json());

  const first = await send("@codex check that the UI makes sense");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].harness, "codex");
  assert.equal(starts[0].prompt, "@codex check that the UI makes sense");
  assert.match(first.detail, /@codex starting a new session/);

  const codex = { ...loadConfig({ ...env, AI_COLLAB_PEER: "codex" }), session: sessionLabel("x1") };
  // A session counts as running while its recorded process lives: use this test's own process.
  const start = readFileSync(`/proc/${process.pid}/stat`, "utf8").split(") ")[1].split(" ")[19];
  await recordSession(codex, { id: "x1", cwd: home, harness: "codex", event: "SessionStart", proc: { pid: process.pid, start } });
  const second = await send("@codex also check the header");
  assert.equal(starts.length, 1, "a running session gets the post instead of a new start");
  assert.match(second.detail, /@codex sent to 1 session/);
  assert.deepEqual((await claimInbox(codex)).map(m => m.body), ["@codex also check the header"]);
});

test("a post that only @harness:model-starts a session starts it and stays out of every running session's inbox", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-mention-start-only-"));
  const bin = path.join(home, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "codex"), "#!/bin/sh\n");
  chmodSync(path.join(bin, "codex"), 0o755);
  const stateDir = path.join(home, "state");
  const env = { ...peerEnv(fake, { peer: "operator", stateDir, AI_COLLAB_PEERS: "claude,codex" }), HOME: home, PATH: bin + path.delimiter + process.env.PATH };
  const cfg = loadConfig(env);
  // A running Claude session, in this test's process, that a broadcast post would otherwise reach.
  const claude = { ...loadConfig({ ...env, AI_COLLAB_PEER: "claude" }), session: sessionLabel("c1") };
  const start = readFileSync(`/proc/${process.pid}/stat`, "utf8").split(") ")[1].split(" ")[19];
  await recordSession(claude, { id: "c1", cwd: home, harness: "claude", event: "SessionStart", proc: { pid: process.pid, start } });
  const other = { ...loadConfig({ ...env, AI_COLLAB_PEER: "codex" }), session: sessionLabel("x1") };
  await recordSession(other, { id: "x1", cwd: home, harness: "codex", event: "SessionStart", proc: { pid: process.pid, start } });
  const starts = [];
  const ui = createUi({ cfg, env, models: async () => ({ codex: ["gpt-5-codex"], claude: ["haiku"] }), start: async (_cfg, options) => { starts.push(options); return { status: "starting" }; } });
  t.after(() => ui.close());
  const send = (target, body) => ui.handle(new Request(`${base}/api/send`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ target, body }),
  }), "send").then(r => r.json());

  const started = await send("all", "@codex:gpt-5-codex build the header");
  assert.equal(starts.length, 1, "the tag still starts its session");
  assert.equal(starts[0].harness, "codex");
  assert.equal(starts[0].model, "gpt-5-codex");
  assert.match(started.detail, /@codex:gpt-5-codex starting a new session/);
  // No running session takes it: the post names only the session it starts.
  assert.deepEqual(await claimInbox(claude, { commit: false }), []);
  assert.deepEqual(await claimInbox(other, { commit: false }), []);
  // It stays legible on the project channel for the phone, marked as a start.
  const posted = fake.state.publishes.filter(p => p.topic === "ai-collab-demo--to--all").map(p => parseWireEnvelope(p.message)).filter(Boolean);
  const envelope = posted.find(e => e.body === "@codex:gpt-5-codex build the header");
  assert.equal(envelope?.startOnly, true);
  assert.equal(envelope?.from, "operator");
});

test("a post that tags a running agent as well as starting one still reaches that agent", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-mention-mixed-"));
  const bin = path.join(home, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "codex"), "#!/bin/sh\n");
  chmodSync(path.join(bin, "codex"), 0o755);
  const stateDir = path.join(home, "state");
  const env = { ...peerEnv(fake, { peer: "operator", stateDir, AI_COLLAB_PEERS: "claude,codex" }), HOME: home, PATH: bin + path.delimiter + process.env.PATH };
  const cfg = loadConfig(env);
  const claude = { ...loadConfig({ ...env, AI_COLLAB_PEER: "claude" }), session: sessionLabel("c1") };
  await recordSession(claude, { id: "c1", cwd: home, harness: "claude", event: "SessionStart" });
  const starts = [];
  const ui = createUi({ cfg, env, models: async () => ({ codex: ["gpt-5-codex"] }), start: async (_cfg, options) => { starts.push(options); return { status: "starting" }; } });
  t.after(() => ui.close());
  const send = (body) => ui.handle(new Request(`${base}/api/send`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ target: "all", body }),
  }), "send").then(r => r.json());

  // A model tag beside a plain harness tag: the plain tag makes the post an ordinary broadcast.
  const mixed = await send("@codex:gpt-5-codex and @claude look");
  assert.equal(starts.length, 1, "the model tag still starts its session");
  assert.equal(starts[0].model, "gpt-5-codex");
  assert.match(mixed.detail, /@codex:gpt-5-codex starting a new session/);
  assert.deepEqual((await claimInbox(claude, { commit: false })).map(m => m.body), ["@codex:gpt-5-codex and @claude look"]);
});
