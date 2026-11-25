import { parseWireEnvelope } from "../lib/agui.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { MESSAGE_MAX_BYTES, loadConfig, sessionLabel } from "../lib/config.mjs";
import { closeTerminalCards, decideApproval } from "../lib/approvals.mjs";
import { currentModeKnown } from "../lib/mode.mjs";
import { createUi } from "../web/server/ui.mjs";
import { IN_TERMINAL_STALE } from "../web/lib/a2ui.js";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";

const HOOK = fileURLToPath(new URL("../scripts/ai-collab-hook.mjs", import.meta.url));
const ALL = "ai-collab-demo--to--all";
const SESSION = "aabbccddeeff0011";
const QUESTIONS = [{
  question: "Which framework?", header: "Framework", multiSelect: false,
  options: [{ label: "React", description: "Component library", preview: "<App/>" }, { label: "Vue" }],
}];
const ASK = { tool_name: "AskUserQuestion", tool_input: { questions: QUESTIONS } };
const BASH = { tool_name: "Bash", tool_input: { command: "make deploy" } };

const setMode = (fake, mode) => fake.inject(ALL, JSON.stringify({ v: 1, kind: "mode", from: "operator", mode, ts: Date.now() }));
const envelopes = (fake, kind) => fake.state.publishes.map(p => { try { return { ...parseWireEnvelope(p.message), raw: p.message, title: p.title }; } catch { return null; } })
  .filter(m => m?.kind === kind);

async function setup(t, extra = {}) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "claude", AI_COLLAB_PEERS: "claude,codex,cursor", ...extra });
  return { fake, env, cfg: { ...loadConfig(env), session: SESSION } };
}

function runHook(args, input, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [HOOK, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => resolve({ out: JSON.parse(out), ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(input));
  });
}

test("AFK off: a view-only card is published and the hook returns no decision at once", async (t) => {
  const { fake, cfg } = await setup(t);
  const started = Date.now();
  assert.deepEqual(await decideApproval(cfg, { host: "claude", key: "permissionrequest", input: ASK }), {});
  assert.ok(Date.now() - started < 1500, "returns without waiting for a reply");
  assert.equal(envelopes(fake, "approval").length, 0, "no answerable approval in mode off");
  const [card] = envelopes(fake, "approval-view");
  assert.equal(card.mode, "terminal");
  assert.equal(card.session, SESSION);
  assert.equal(card.tool, "AskUserQuestion");
  assert.equal(card.summary, "Which framework?");
  assert.equal(card.questions[0].options[0].preview, "<App/>");
  assert.ok(card.expiresAt > Date.now());
  assert.match(card.title, /terminal/);
  assert.equal(fake.state.subscribes.length, 0, "never waits on the topic");

  assert.deepEqual(await decideApproval(cfg, { host: "codex", key: "permissionrequest", input: { tool_name: "shell", tool_input: { command: ["git", "push"] } } }), {});
  assert.equal(envelopes(fake, "approval-view")[1].summary, "git push");
});

test("AFK off: the view-only card reuses the ON-mode cleaning and size limit", async (t) => {
  const { fake, cfg } = await setup(t);
  const big = [{ question: "Pick\u0007 one", header: "H", options: Array.from({ length: 9 }, (_, i) => ({ label: "L" + i, description: "d".repeat(400), preview: "p".repeat(3000) })) }];
  await decideApproval(cfg, { host: "claude", key: "permissionrequest", input: { tool_name: "AskUserQuestion", tool_input: { questions: big } } });
  const [card] = envelopes(fake, "approval-view");
  assert.ok(Buffer.byteLength(card.raw) <= MESSAGE_MAX_BYTES);
  assert.equal(card.questions[0].question, "Pick one");
  assert.equal(card.questions[0].options.length, 6);
  assert.ok(card.questions[0].options.every(o => (o.preview || "").length <= 2000 && (o.description || "").length <= 300));
  assert.equal(Object.hasOwn(card, "input"), false, "the raw tool input is never published");

  await decideApproval(cfg, { host: "claude", key: "permissionrequest", input: { tool_name: "Bash", tool_input: { command: "x".repeat(5000) } } });
  assert.ok(envelopes(fake, "approval-view")[1].summary.length <= 300);
});

test("AFK off: Cursor, a session-less hook, and disabled approvals publish nothing", async (t) => {
  const { fake, cfg } = await setup(t);
  assert.deepEqual(await decideApproval(cfg, { host: "cursor", key: "beforeshellexecution", input: { command: "ls" }, mode: () => ({ mode: "off", ts: 0 }) }), { permission: "ask" });
  assert.deepEqual(await decideApproval({ ...cfg, session: "" }, { host: "claude", key: "permissionrequest", input: BASH }), {});
  assert.deepEqual(await decideApproval({ ...cfg, approvalS: 0 }, { host: "claude", key: "permissionrequest", input: BASH }), {});
  assert.equal(envelopes(fake, "approval-view").length, 0);
});

test("an unreadable mode is not off: a headless session still asks the phone instead of publishing a terminal card", async (t) => {
  const { fake, cfg } = await setup(t, { AI_COLLAB_APPROVAL_S: "1" });
  setMode(fake, "on");
  // The poll is rate-limited, and nothing on this machine has read the mode: the hook cannot tell, so it must not say off.
  fake.state.limitNext = 50;
  const started = Date.now();
  assert.deepEqual(await decideApproval(cfg, { host: "claude", key: "permissionrequest", input: BASH }), {});
  assert.ok(Date.now() - started >= 900, "it waited out the approval window rather than returning at once");
  assert.equal(envelopes(fake, "approval-view").length, 0, "no view-only card claiming the terminal");
  const [card] = envelopes(fake, "approval");
  assert.equal(card.summary, "make deploy", "the phone got the answerable card");
  assert.equal(envelopes(fake, "approval-end")[0].reason, "timeout");
});

test("a recorded mode survives a failed read, so AFK on stays on for a headless session", async (t) => {
  const { fake, cfg } = await setup(t, { AI_COLLAB_APPROVAL_S: "1" });
  setMode(fake, "on");
  // One good read records the project's mode for sessions whose own read later fails.
  assert.equal((await currentModeKnown(cfg)).mode, "on");
  fake.state.limitNext = 50;
  const offline = { ...cfg, session: "0102030405060708" };
  const started = Date.now();
  assert.deepEqual(await decideApproval(offline, { host: "claude", key: "permissionrequest", input: BASH }), {});
  assert.ok(Date.now() - started >= 900, "AFK on waited for the phone, not the terminal");
  assert.equal(envelopes(fake, "approval-view").length, 0);
  assert.equal(envelopes(fake, "approval").length, 1);
});

test("the next tool result with the same tool and summary closes the card; Stop closes the rest", async (t) => {
  const { fake, cfg } = await setup(t);
  await decideApproval(cfg, { host: "claude", key: "permissionrequest", input: ASK });
  await decideApproval(cfg, { host: "claude", key: "permissionrequest", input: BASH });
  const [ask, bash] = envelopes(fake, "approval-view");

  assert.deepEqual(await closeTerminalCards(cfg, { host: "claude", key: "pretooluse", input: BASH }), []);
  assert.deepEqual(await closeTerminalCards(cfg, { host: "claude", key: "notification", input: {} }), [], "Notification fires while the prompt shows");
  assert.deepEqual(await closeTerminalCards(cfg, { host: "claude", key: "posttooluse", input: { tool_name: "Bash", tool_input: { command: "ls" } } }), []);
  const answered = { ...ASK, tool_input: { ...ASK.tool_input, answers: { "Which framework?": "Vue" } }, tool_response: {} };
  assert.deepEqual(await closeTerminalCards(cfg, { host: "claude", key: "posttooluse", input: answered }), [ask.id]);
  assert.deepEqual(await closeTerminalCards(cfg, { host: "claude", key: "posttooluse", input: answered }), [], "closed once");
  assert.deepEqual(await closeTerminalCards(cfg, { host: "claude", key: "stop", input: {} }), [bash.id]);

  const ends = envelopes(fake, "approval-end");
  assert.deepEqual(ends.map(e => [e.id, e.reason, e.session]), [[ask.id, "terminal", SESSION], [bash.id, "terminal", SESSION]]);
  assert.deepEqual(await closeTerminalCards(cfg, { host: "claude", key: "stop", input: {} }), []);
});

test("AFK on keeps the phone wait and records no view-only card", async (t) => {
  const { fake, cfg } = await setup(t, { AI_COLLAB_APPROVAL_S: "1" });
  setMode(fake, "on");
  assert.deepEqual(await decideApproval(cfg, { host: "claude", key: "permissionrequest", input: BASH }), {});
  assert.equal(envelopes(fake, "approval").length, 1);
  assert.equal(envelopes(fake, "approval-view").length, 0);
  assert.deepEqual(await closeTerminalCards(cfg, { host: "claude", key: "stop", input: {} }), []);
});

test("the hook script publishes the card, returns {} at once, and a later event closes it", async (t) => {
  const { fake, env } = await setup(t);
  const base = { session_id: "s-terminal", cwd: "/tmp" };
  const asked = await runHook(["--host", "claude"], { ...base, hook_event_name: "PermissionRequest", ...ASK }, env);
  assert.deepEqual(asked.out, {});
  assert.ok(asked.ms < 5000, `hook took ${asked.ms} ms`);
  const [card] = envelopes(fake, "approval-view");
  assert.equal(card.session, sessionLabel("s-terminal"));

  const post = await runHook(["--host", "claude"], { ...base, hook_event_name: "PostToolUse", ...ASK, tool_response: {} }, env);
  assert.equal(post.out.hookSpecificOutput?.decision, undefined, "PostToolUse output is unchanged");
  assert.deepEqual(envelopes(fake, "approval-end").map(e => [e.id, e.reason]), [[card.id, "terminal"]]);

  // A denied prompt: an activity-only registration (PostToolUseFailure) still closes it.
  await runHook(["--host", "claude"], { ...base, hook_event_name: "PermissionRequest", ...BASH }, env);
  const bash = envelopes(fake, "approval-view")[1];
  await runHook(["--activity", "--host", "claude"], { ...base, hook_event_name: "PostToolUseFailure", ...BASH, error: "rejected" }, env);
  assert.equal(envelopes(fake, "approval-end")[1].id, bash.id);

  const codexEnv = { ...env, AI_COLLAB_PEER: "codex" };
  await runHook(["--host", "codex"], { ...base, session_id: "c-terminal", hook_event_name: "PermissionRequest", tool_name: "shell", tool_input: { command: ["ls"] } }, codexEnv);
  const codex = envelopes(fake, "approval-view")[2];
  await runHook(["--host", "codex"], { ...base, session_id: "c-terminal", hook_event_name: "Stop" }, codexEnv);
  assert.deepEqual(envelopes(fake, "approval-end")[2], { ...envelopes(fake, "approval-end")[2], id: codex.id, reason: "terminal", from: "codex" });
});

test("the UI shows a view-only card without answers, refuses replies, and closes it on the terminal end", async (t) => {
  const { fake, cfg } = await setup(t);
  const pushed = [];
  const push = { notify: async (key) => { pushed.push(key); return { sent: 1 }; }, publicKey: () => "", subscribe() {}, unsubscribe: () => 0, subscriptions: () => [] };
  const ui = createUi({ cfg: loadConfig(peerEnv(fake, { peer: "operator", AI_COLLAB_PEERS: "claude,codex,cursor" })), push });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const base = "http://127.0.0.1:8795";
  const post = (body) => ui.handle(new Request(`${base}/api/approve`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), "approve");
  const stream = sse(ui.events(new Request(`${base}/api/events`, { signal: ctrl.signal })));
  async function until(check) {
    for (;;) {
      const { done, value } = await stream.next();
      if (done) throw new Error("stream ended");
      if (value.event === "problem") throw new Error(value.data.error);
      if (value.event !== "state") continue;
      const state = value.data;
      const cards = state.messages.filter(m => m.kind === "Approval");
      if (check(cards)) return cards;
    }
  }
  await until(() => true);
  await decideApproval(cfg, { host: "claude", key: "permissionrequest", input: ASK });
  const [card] = envelopes(fake, "approval-view");
  const open = await until(list => list.length === 1);
  assert.equal(open[0].approval.terminal, true);
  assert.equal(open[0].approval.state, "pending");
  assert.equal(open[0].approval.questions[0].question, "Which framework?");

  const refused = await post({ id: card.id, answers: { "Which framework?": "Vue" } });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /terminal/);

  await closeTerminalCards(cfg, { host: "claude", key: "stop", input: {} });
  const closed = await until(list => list[0]?.approval.state !== "pending");
  assert.equal(closed[0].approval.state, "terminal");
  await delay(50);
  assert.equal(pushed.length, 0, "a view-only card sends no push");
  assert.ok(!fake.state.publishes.some(p => p.message.startsWith(`reply ${card.id}`)), "nothing answers a terminal card");
});

test("a terminal card never tells the UI AFK is off while the project is away", async (t) => {
  const { fake, cfg } = await setup(t);
  const ui = createUi({ cfg: loadConfig(peerEnv(fake, { peer: "operator", AI_COLLAB_PEERS: "claude,codex,cursor" })) });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const base = "http://127.0.0.1:8795";
  // The card was published by a hook that read AFK off; the operator turned AFK back on while it stayed open.
  setMode(fake, "off");
  await decideApproval(cfg, { host: "claude", key: "permissionrequest", input: BASH });
  const [card] = envelopes(fake, "approval-view");
  setMode(fake, "on");

  const stream = sse(ui.events(new Request(`${base}/api/events?project=demo`, { signal: ctrl.signal })));
  for await (const { event, data } of stream) {
    if (event === "problem") throw new Error(data.error);
    if (event !== "surface" || data.id !== "approval-" + card.id) continue;
    const parts = data.operations.find(op => op.updateComponents).updateComponents.components;
    const hint = parts.find(part => part.id === "hint")?.text;
    if (hint === undefined) continue;
    assert.equal(hint, IN_TERMINAL_STALE, "AFK is on again, so the hint must not say it is off");
    assert.doesNotMatch(hint, /AFK is off/);
    return;
  }
  throw new Error("no surface for the view-only card");
});
