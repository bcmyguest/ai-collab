// A tag start the operator wrote that starts nothing says so in the chat, as an ai-collab system message (the same kind a
// failed pattern run posts), not only in the small per-message note: a paused project, a refused model, a session that ends
// on a usage limit before it replies.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseWireEnvelope } from "../lib/agui.mjs";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { resetClock } from "../lib/limit-alert.mjs";
import { setProjectPaused } from "../lib/project-pause.ts";
import { recordSession } from "../lib/sessions.mjs";
import { codexResetFrom, classifyLimit, limitFromRunError } from "../lib/limits.mjs";
import { limitEndNotice, readStartLog } from "../lib/start-limit.mjs";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const base = "http://127.0.0.1:8797";
const ALL = "ai-collab-demo--to--all";

// The log a tag-started `codex exec --json` wrote on 2026-11-24 (reply text trimmed): it ended in 8 seconds on the usage limit.
const LIMIT_TEXT = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 1:14 PM.";
const CODEX_LOG = [
  { type: "thread.started", thread_id: "01a20e68-b95f-7b32-b1df-76a5d95a9106" },
  { type: "item.completed", item: { id: "item_0", type: "error", message: "`--dangerously-bypass-hook-trust` is enabled." } },
  { type: "turn.started" },
  { type: "error", message: LIMIT_TEXT },
  { type: "turn.failed", error: { message: LIMIT_TEXT } },
].map((event) => JSON.stringify(event)).join("\n");

async function world(t, { peers = "claude,codex,opencode" } = {}) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-start-refusal-"));
  const bin = path.join(home, "bin");
  mkdirSync(bin);
  const stateDir = path.join(home, "state");
  const env = { ...peerEnv(fake, { peer: "operator", stateDir, AI_COLLAB_PEERS: peers }), HOME: home, PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter), AI_COLLAB_SCOPE: "off", AI_COLLAB_UI_ORIGIN: "x" };
  const installed = (name, script) => { writeFileSync(path.join(bin, name), script); chmodSync(path.join(bin, name), 0o755); };
  return { fake, home, bin, env, stateDir, installed, cfg: loadConfig(env) };
}

const sender = (ui) => (target, body) => ui.handle(new Request(`${base}/api/send`, {
  method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ target, body }),
}), "send").then((r) => r.json());

const systemNotes = (fake, topic) => fake.state.publishes.filter((p) => p.topic === topic).map((p) => parseWireEnvelope(p.message)).filter((e) => e?.system === true);

async function waitFor(read) {
  for (let i = 0; i < 200; i++) {
    const found = read();
    if (found) return found;
    await delay(25);
  }
  return null;
}

test("a paused tag start posts a system message naming the tag and the reason, and keeps the per-message note", async (t) => {
  const { fake, env, cfg, installed } = await world(t);
  installed("codex", "#!/bin/sh\n");
  setProjectPaused(cfg, true);
  const starts = [];
  const ui = createUi({ cfg, env, models: async () => ({ codex: ["gpt-6.2-sol"] }), start: async (_cfg, options) => { starts.push(options); return { status: "starting" }; } });
  t.after(() => ui.close());

  const sent = await sender(ui)("all", "@codex:gpt-6.2-sol fix the outage");
  assert.equal(starts.length, 0, "a paused project starts nothing");
  assert.match(sent.detail, /@codex:gpt-6.2-sol: New work is paused for this project/, "the per-message note stays");

  const [note, ...more] = systemNotes(fake, ALL);
  assert.equal(more.length, 0);
  assert.equal(note.from, "operator");
  assert.equal(note.to, "all");
  assert.equal(note.body, "@codex:gpt-6.2-sol did not start: New work is paused for this project. Resume new work to start it.");
  assert.equal(note.startOnly, true, "no running agent is woken by a notice for the operator");
});

test("a refused tag start in a session's chat posts the system message in that chat; an unknown model and a missing harness say so", async (t) => {
  const { fake, home, env, cfg, installed } = await world(t);
  installed("codex", "#!/bin/sh\n");
  const claude = { ...loadConfig({ ...env, AI_COLLAB_PEER: "claude" }), session: sessionLabel("c1") };
  await recordSession(claude, { id: "c1", cwd: home, harness: "claude", event: "SessionStart" });
  const address = `claude#${claude.session}`;
  const ui = createUi({ cfg, env, models: async () => ({ codex: ["gpt-6.2-sol"] }), start: async () => ({ status: "starting" }) });
  t.after(() => ui.close());
  const send = sender(ui);

  await send(address, "@codex:nope do X");
  await send("all", "@opencode:big-pickle do Y");
  const direct = systemNotes(fake, "ai-collab-demo--to--claude").map((e) => e.body);
  assert.deepEqual(direct, ["@codex:nope did not start: codex lists no model named nope."]);
  assert.equal(systemNotes(fake, "ai-collab-demo--to--claude").at(0).toSession, claude.session);
  assert.deepEqual(systemNotes(fake, ALL).map((e) => e.body), ["@opencode:big-pickle did not start: opencode is not available here."]);
});

test("a second tag start inside ten seconds and a failed start each post a system message", async (t) => {
  const { fake, env, cfg, installed } = await world(t);
  installed("codex", "#!/bin/sh\n");
  let calls = 0;
  const ui = createUi({ cfg, env, models: async () => ({ codex: ["gpt-6.2-sol"] }), start: async () => (++calls === 1 ? { status: "failed", detail: "codex is not installed" } : { status: "starting" }) });
  t.after(() => ui.close());
  const send = sender(ui);

  await send("all", "@codex:gpt-6.2-sol one");
  await send("all", "@codex:gpt-6.2-sol two");
  assert.deepEqual(systemNotes(fake, ALL).map((e) => e.body), [
    "@codex:gpt-6.2-sol did not start: start failed: codex is not installed.",
    "@codex:gpt-6.2-sol did not start: wait 10 seconds between starts.",
  ]);
});

test("a started tag session that ends on a Codex usage limit posts a limit system message with the reset time", async (t) => {
  const { fake, home, env, cfg, installed } = await world(t);
  const root = path.join(home, "project");
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  mkdirSync(root);
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo", url: fake.url, peers: "claude,codex" }]));
  // The real launcher runs this stand-in `codex exec`: the log of the 16:34 session, then exit 1 as the CLI did.
  installed("codex", `#!/usr/bin/env node\nconsole.log(${JSON.stringify(CODEX_LOG)});\nprocess.exit(1);\n`);
  const ui = createUi({ cfg, env, models: async () => ({ codex: ["gpt-6.2-sol"] }) });
  t.after(() => ui.close());

  const sent = await sender(ui)("all", "@codex:gpt-6.2-sol fix the outage");
  assert.match(sent.detail, /@codex:gpt-6.2-sol starting a new session/);
  const note = await waitFor(() => systemNotes(fake, ALL).find((e) => /ended without a reply/.test(e.body)));
  assert.ok(note, "the operator hears that the session ended on its limit");
  assert.equal(note.from, "operator");
  assert.match(note.body, /^@codex:gpt-6\.2-sol ended without a reply: Limit reached · codex:gpt-6\.2-sol · resets \d\d:\d\d\.$/);
  assert.ok(note.body.includes("resets 13:14"), note.body);
});

test("Codex's usage_limit_exceeded code and its 'try again at' time are read by the shared classifier", () => {
  const now = new Date(2026, 10, 24, 11, 34).getTime();
  const at = (h, m, day = 24) => new Date(2026, 10, day, h, m).getTime();
  assert.equal(codexResetFrom(LIMIT_TEXT, now), at(13, 14));
  assert.equal(codexResetFrom("try again at 9:05 AM", now), at(9, 5, 25), "a clock time already past means tomorrow");
  assert.equal(codexResetFrom("try again at 12:30 AM.", now), at(0, 30, 25));
  assert.equal(codexResetFrom("You've hit your usage limit. try again at Nov 29th, 2099 3:10 PM.", now), new Date(2099, 10, 29, 15, 10).getTime());
  assert.equal(codexResetFrom("try again later", now), null);

  // The rollout file's snake_case code is a limit even when the text names no limit; the app-server's camelCase one still is.
  for (const codexErrorInfo of ["usage_limit_exceeded", "usageLimitExceeded"]) {
    const found = classifyLimit("codex", { kind: "turn_error", message: "Something went wrong", codexErrorInfo });
    assert.equal(found?.harness, "codex", codexErrorInfo);
    assert.equal(found.wording, true);
  }
  assert.equal(classifyLimit("codex", { kind: "turn_error", message: "Something went wrong", codexErrorInfo: "other" }), null);
  const fromRunError = limitFromRunError("codex", LIMIT_TEXT, { codexErrorInfo: "usage_limit_exceeded" });
  assert.equal(resetClock(fromRunError.resetsAt), "13:14");
});

test("a session log is a limit end only when it has a limit error and no reply", () => {
  const notice = limitEndNotice({ tag: "@codex:gpt-6.2-sol", harness: "codex", model: "gpt-6.2-sol", log: CODEX_LOG });
  assert.match(notice, /^@codex:gpt-6\.2-sol ended without a reply: Limit reached · codex:gpt-6\.2-sol · resets 13:14\.$/);

  const answered = `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "On it." } })}\n${CODEX_LOG}`;
  assert.equal(readStartLog(answered).replied, true);
  assert.equal(limitEndNotice({ tag: "@codex", harness: "codex", log: answered }), null, "a reply came first");
  assert.equal(limitEndNotice({ tag: "@codex", harness: "codex", log: JSON.stringify({ type: "turn.completed" }) }), null);
  assert.equal(limitEndNotice({ tag: "@codex", harness: "codex", log: "" }), null);

  // Cursor prints its limit as plain stderr text, which names a monthly cycle and no clock time.
  const cursor = `${JSON.stringify({ type: "user", message: {} })}\nActionRequiredError: You've hit your usage limit. Your usage limits will reset when your monthly cycle ends on 12/18/2026.`;
  assert.equal(limitEndNotice({ tag: "@cursor:composer-2.5", harness: "cursor", model: "composer-2.5", log: cursor }),
    "@cursor:composer-2.5 ended without a reply: Limit reached · cursor:composer-2.5 · reset time unknown.");
});
