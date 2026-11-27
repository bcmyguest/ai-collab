import { parseWireEnvelope } from "../lib/agui.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { broadcastTopic, loadConfig } from "../lib/config.mjs";
import { WAIT_LABEL, alertLimit, chooseLimit } from "../lib/limit-alert.ts";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";

const base = "http://127.0.0.1:8795";
const SESSION = "aabbccddeeff0011";
const LISTED = { claude: ["sonnet"], codex: ["gpt-5"], cursor: [], opencode: [] };
const LIMIT = { window: "five_hour", windowName: "5-hour", resetsAt: null, verified: true, source: "test" };

async function setup(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "alice" });
  const cfg = loadConfig(env);
  const sessionCfg = { ...cfg, session: SESSION };
  return { fake, env, cfg, sessionCfg };
}

const startOk = (calls) => async (cfg, args) => { calls.push(args); return { status: "started", detail: "codex started in demo", session: "codex#0123456789abcdef" }; };

test("chooseLimit starts a replacement once with the handoff, and a second pick is a duplicate", async (t) => {
  const { sessionCfg, cfg } = await setup(t);
  const sent = await alertLimit(sessionCfg, { harness: "claude", limit: LIMIT, listed: async () => LISTED, available: () => ["codex"], send: async () => {} });
  const calls = [];
  const first = await chooseLimit(cfg, { id: sent.id, label: "codex:gpt-5", start: startOk(calls) });
  assert.equal(first.status, "started");
  assert.equal(first.session, "codex#0123456789abcdef");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].harness, "codex");
  assert.equal(calls[0].model, "gpt-5");
  assert.equal(calls[0].place, "folder");
  assert.match(calls[0].prompt, /Continue the work that alice#aabbccddeeff0011 \(claude\) left when it hit a 5-hour limit/);
  assert.match(calls[0].prompt, /Session title: not recorded\./);
  assert.equal((await chooseLimit(cfg, { id: sent.id, label: "codex:gpt-5", start: startOk(calls) })).status, "duplicate");
  assert.equal(calls.length, 1);
});

test("Wait for reset acknowledges without starting anything", async (t) => {
  const { sessionCfg, cfg } = await setup(t);
  const sent = await alertLimit(sessionCfg, { harness: "claude", limit: LIMIT, listed: async () => LISTED, available: () => ["codex"], send: async () => {} });
  const calls = [];
  assert.deepEqual(await chooseLimit(cfg, { id: sent.id, label: WAIT_LABEL, start: startOk(calls) }), { status: "waiting", detail: "Waiting for reset" });
  assert.equal(calls.length, 0);
});

test("a failed start releases the card so the operator can pick again", async (t) => {
  const { sessionCfg, cfg } = await setup(t);
  const sent = await alertLimit(sessionCfg, { harness: "claude", limit: LIMIT, listed: async () => LISTED, available: () => ["codex"], send: async () => {} });
  const failing = async () => ({ status: "failed", detail: "codex is not installed" });
  assert.deepEqual(await chooseLimit(cfg, { id: sent.id, label: "codex:gpt-5", start: failing }), { status: "failed", detail: "codex is not installed" });
  assert.equal((await chooseLimit(cfg, { id: sent.id, label: "codex:gpt-5", start: startOk([]) })).status, "started");
});

test("an option that is not on the card, or an unknown card, starts nothing", async (t) => {
  const { sessionCfg, cfg } = await setup(t);
  const sent = await alertLimit(sessionCfg, { harness: "claude", limit: LIMIT, listed: async () => LISTED, available: () => ["codex"], send: async () => {} });
  assert.equal((await chooseLimit(cfg, { id: sent.id, label: "cursor:auto", start: startOk([]) })).status, "failed");
  assert.equal((await chooseLimit(cfg, { id: "ffffffffffff", label: "codex:gpt-5", start: startOk([]) })).status, "failed");
});

test("typed text picks a replacement: a bare name matches another harness's listed model, harness:model names one", async (t) => {
  const { sessionCfg, cfg } = await setup(t);
  const models = { claude: ["sonnet"], codex: ["gpt-5"], cursor: ["auto", "deepseek-v41-flash-1017-high"], opencode: ["opencode/deepseek-v4.1-flash-free"] };
  const opts = { listed: async () => models, available: () => ["claude", "codex", "cursor", "opencode"] };
  const sent = await alertLimit(sessionCfg, { harness: "codex", limit: LIMIT, ...opts, send: async () => {} });
  const calls = [];
  const typed = await chooseLimit(cfg, { id: sent.id, typed: "DeepSeek", start: startOk(calls), ...opts });
  assert.equal(typed.status, "started");
  assert.deepEqual([calls[0].harness, calls[0].model], ["cursor", "deepseek-v41-flash-1017-high"]);
  const other = await alertLimit(sessionCfg, { harness: "claude", limit: { ...LIMIT, window: "weekly", windowName: "weekly" }, ...opts, send: async () => {} });
  assert.equal((await chooseLimit(cfg, { id: other.id, typed: "opencode:opencode/deepseek-v4.1-flash-free", start: startOk(calls), ...opts })).status, "started");
  assert.deepEqual([calls[1].harness, calls[1].model], ["opencode", "opencode/deepseek-v4.1-flash-free"]);
});

test("typed text that names no listed model, or only the limited harness, starts nothing", async (t) => {
  const { sessionCfg, cfg } = await setup(t);
  const opts = { listed: async () => ({ ...LISTED, cursor: ["auto"] }), available: () => ["claude", "codex", "cursor"] };
  const sent = await alertLimit(sessionCfg, { harness: "claude", limit: LIMIT, ...opts, send: async () => {} });
  const calls = [];
  const none = await chooseLimit(cfg, { id: sent.id, typed: "deepseek", start: startOk(calls), ...opts });
  assert.equal(none.status, "failed");
  assert.match(none.detail, /No listed model matches "deepseek"/);
  assert.equal((await chooseLimit(cfg, { id: sent.id, typed: "sonnet", start: startOk(calls), ...opts })).status, "failed");
  assert.equal(calls.length, 0);
});

test("the UI answers a limit card through the choice surface and starts the replacement", async (t) => {
  const { fake, sessionCfg, cfg } = await setup(t);
  const sent = await alertLimit(sessionCfg, { harness: "claude", limit: LIMIT, listed: async () => LISTED, available: () => ["codex"] });
  assert.ok(fake.state.publishes.some((p) => p.topic === broadcastTopic(cfg.project)));
  const calls = [];
  const ui = createUi({ cfg, start: startOk(calls) });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const timer = setTimeout(() => ctrl.abort(), 5000);
  t.after(() => clearTimeout(timer));
  const stream = sse(ui.events(new Request(`${base}/api/events?project=demo`, { signal: ctrl.signal })));
  const post = (picks) => ui.handle(new Request(`${base}/api/a2ui`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ project: "demo", forwardedProps: { a2uiAction: { userAction: { name: "answer", surfaceId: `approval-${sent.id}`, sourceComponentId: "submit", timestamp: "2026-11-22T10:00:00Z", context: { id: sent.id, picks, other: [""] } } } } }),
  }), "a2ui");
  for await (const frame of stream) {
    if (frame.event !== "surface" || frame.data.id !== `approval-${sent.id}`) continue;
    assert.equal((await post([["codex:gpt-5"]])).status, 201);
    break;
  }
  assert.equal(calls.length, 1);
  const ends = fake.state.publishes.flatMap((p) => { try { const m = parseWireEnvelope(p.message); return m.kind === "approval-end" ? [m] : []; } catch { return []; } });
  assert.deepEqual(ends.map((m) => [m.id, m.reason]), [[sent.id, "answered"]]);
  assert.equal((await post([["codex:gpt-5"]])).status, 409);
  assert.equal(calls.length, 1);
});

const rowsOf = (fake, type) => fake.state.publishes.flatMap((p) => { try { const m = parseWireEnvelope(p.message); return m.kind === "activity" && m.type === type ? [m] : []; } catch { return []; } });

test("a limit leaves a timeline row, and a pick links the original and the replacement", async (t) => {
  const { fake, sessionCfg, cfg } = await setup(t);
  const sent = await alertLimit(sessionCfg, { harness: "claude", limit: LIMIT, listed: async () => LISTED, available: () => ["codex"] });
  const [limitRow] = rowsOf(fake, "limit");
  assert.equal(limitRow.input, "Limit reached · claude · 5-hour · reset time unknown");
  assert.equal(limitRow.session, SESSION);
  assert.equal(limitRow.harness, "claude");
  await chooseLimit(cfg, { id: sent.id, label: "codex:gpt-5", start: startOk([]) });
  const [origin, replacement] = rowsOf(fake, "handoff");
  assert.equal(origin.session, SESSION);
  assert.equal(origin.input, "Replacement started: codex#0123456789abcdef");
  assert.equal(replacement.session, "0123456789abcdef");
  assert.equal(replacement.harness, "codex");
  assert.equal(replacement.input, "Continues alice#aabbccddeeff0011 after a limit");
});

test("defaults.json limitFallback is the first replacement when the role has none", async (t) => {
  const { sessionCfg, env } = await setup(t);
  const config = mkdtempSync(path.join(tmpdir(), "ai-collab-lf-"));
  mkdirSync(path.join(config, "ai-collab"), { recursive: true });
  writeFileSync(path.join(config, "ai-collab", "defaults.json"), JSON.stringify({ limitFallback: "opencode:opencode/deepseek-v4.1-flash-free" }));
  const sent = await alertLimit(sessionCfg, { harness: "codex", limit: LIMIT, env: { ...env, XDG_CONFIG_HOME: config }, listed: async () => LISTED, available: () => ["claude", "opencode"], send: async () => {} });
  assert.equal(sent.options[0], "opencode:opencode/deepseek-v4.1-flash-free");
});
