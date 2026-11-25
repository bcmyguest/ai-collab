// Pins today's reply matching, wait limit and approval-end bytes before lib/operator.ts takes them over.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { parseWireEnvelope } from "../lib/agui.mjs";
import { loadConfig } from "../lib/config.mjs";
import { decideApproval, decideQuestion } from "../lib/approvals.mjs";
import { askQuestion, findAnswers, waitForAnswer } from "../lib/questions.mjs";
import { limitEndMessage } from "../lib/limit-alert.mjs";
import { waitForMessages } from "../lib/agents.mjs";
import { approvalEndMessage } from "../runner/publish.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const ALL = "ai-collab-demo--to--all";
const SESSION = "aabbccddeeff0011";
const ID_A = "0123456789ab";
const ID_B = "fedcba987654";
const ID_C = "13579bdf2468";
const CHOICE = [{ question: "Which framework?", header: "Framework", multiSelect: false, options: [{ label: "React" }, { label: "Vue" }] }];
const MULTI = [{ question: "Which tools?", header: "Tools", multiSelect: true, options: [{ label: "React" }, { label: "Vue" }] }];
const END_TIMESTAMP = /"ts":"[^"]*"|"timestamp":\d+/g;
const endBytes = (raw) => raw.replace(END_TIMESTAMP, (m) => (m.startsWith('"ts"') ? '"ts":"T"' : '"timestamp":0'));

const setMode = (fake, mode) => fake.inject(ALL, JSON.stringify({ v: 1, kind: "mode", from: "operator", mode, ts: Date.now() }));
const envelopes = (fake, kind) => fake.state.publishes.map((p) => { try { return { ...parseWireEnvelope(p.message), topic: p.topic }; } catch { return null; } })
  .filter((m) => m?.kind === kind);

async function published(fake, kind) {
  for (let i = 0; i < 200; i++) {
    const found = envelopes(fake, kind)[0];
    if (found) return found;
    await delay(10);
  }
  throw new Error(`no ${kind} envelope published`);
}

async function setup(t, extra = {}) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "claude", AI_COLLAB_PEERS: "claude,codex,cursor", ...extra });
  return { fake, env, cfg: { ...loadConfig(env), session: SESSION } };
}

const bash = { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm test" } };
const askInput = { hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_use_id: "toolu_a", tool_input: { questions: CHOICE } };

test("approval stream: a reply names its card; a reply to another id, a blank or unknown answer, or a malformed id is ignored", async (t) => {
  const { fake, cfg } = await setup(t);
  setMode(fake, "on");
  const pending = decideApproval(cfg, { host: "claude", key: "permissionrequest", input: bash });
  const asked = await published(fake, "approval");
  fake.inject(ALL, `reply ${ID_B} allow`);
  fake.inject(ALL, `reply ${asked.id}   `);
  fake.inject(ALL, `reply ${asked.id} maybe`);
  fake.inject(ALL, `reply ${asked.id.slice(0, 11)} allow`);
  fake.inject(ALL, `reply ${asked.id} deny`);
  assert.deepEqual(await pending, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "The operator denied this from the AI Collab phone UI." } } });
  assert.equal(envelopes(fake, "approval-end")[0].reason, "denied");
});

test("approval stream: a skip of the card returns no decision and posts no end envelope", async (t) => {
  const { fake, cfg } = await setup(t);
  setMode(fake, "on");
  const pending = decideApproval(cfg, { host: "claude", key: "permissionrequest", input: bash });
  const asked = await published(fake, "approval");
  fake.inject(ALL, JSON.stringify({ v: 1, kind: "approval-end", from: "operator", id: asked.id, reason: "skipped", ts: Date.now() }));
  assert.deepEqual(await pending, {});
  assert.equal(envelopes(fake, "approval-end").length, 0);
});

test("approval stream: a choice card answer returns the chosen labels in updatedInput", async (t) => {
  const { fake, cfg } = await setup(t);
  setMode(fake, "on");
  const pending = decideQuestion(cfg, { input: askInput });
  const asked = await published(fake, "approval");
  fake.inject(ALL, `reply ${asked.id} {"Which framework?":"vue"}`);
  assert.deepEqual(await pending, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { questions: CHOICE, answers: { "Which framework?": "Vue" } } } });
  assert.equal(envelopes(fake, "approval-end")[0].reason, "answered");
});

test("approval stream: a reconnect resumes from the last event id after the backoff", async (t) => {
  const { cfg } = await setup(t, { AI_COLLAB_STOP_POLL_MS: "50" });
  const sent = [];
  const since = [];
  let cardId = null;
  const stream = async function* (c, topics, opts) {
    since.push(opts.since);
    if (since.length === 1) {
      yield { id: "5", message: "unrelated" };
      throw new Error("outage");
    }
    while (!cardId) await delay(5);
    yield { id: "6", message: `reply ${cardId} allow` };
  };
  const send = async (c, topic, message) => {
    sent.push(message);
    cardId ??= parseWireEnvelope(message).id;
  };
  const mode = () => ({ mode: "on", ts: 0 });
  const out = await decideApproval({ ...cfg, approvalS: 5 }, { host: "claude", key: "permissionrequest", input: bash, stream, send, mode });
  assert.equal(out.hookSpecificOutput.decision.behavior, "allow");
  assert.equal(since.length, 2);
  assert.equal(since[1], "5");
});

test("poll path: a reply by id answers, a free-text question takes any non-blank reply", async (t) => {
  const { fake, cfg } = await setup(t);
  fake.inject(ALL, `reply ${ID_A} yes please`);
  assert.deepEqual(await waitForAnswer(cfg, ID_A, { seconds: 2, intervalMs: 20 }), {
    id: ID_A, answer: "yes please", status: "answered", source: "unverified channel broadcast",
  });
});

test("poll path: a skip returns skipped", async (t) => {
  const { fake, cfg } = await setup(t);
  fake.inject(ALL, JSON.stringify({ v: 1, kind: "approval-end", from: "operator", id: ID_B, reason: "skipped", ts: Date.now() }));
  assert.deepEqual(await waitForAnswer(cfg, ID_B, { seconds: 2, intervalMs: 20 }), { id: ID_B, status: "skipped" });
});

test("poll path: a choice answer matches a label case-insensitively and returns the selected labels", async (t) => {
  const { fake, cfg } = await setup(t);
  fake.inject(ALL, `reply ${ID_C} vue`);
  assert.deepEqual(await waitForAnswer(cfg, ID_C, { seconds: 2, intervalMs: 20, questions: CHOICE }), {
    id: ID_C, status: "answered", answer: "Vue", selected: ["Vue"], source: "unverified channel broadcast",
  });
});

test("poll path: a blank reply is malformed and leaves the question pending", async (t) => {
  const { fake, cfg } = await setup(t);
  fake.inject(ALL, `reply ${ID_A}   `);
  assert.deepEqual(await waitForAnswer(cfg, ID_A, { seconds: 0 }), { id: ID_A, status: "pending" });
});

test("poll path: an invalid id or a wait over 45 seconds is refused", async (t) => {
  const { cfg } = await setup(t);
  await assert.rejects(waitForAnswer(cfg, "not-an-id", { seconds: 1 }), /Invalid question ID/);
  await assert.rejects(waitForAnswer(cfg, ID_A, { seconds: 46 }), /^Error: Wait must be an integer from 0 to 45 seconds$/);
});

test("askQuestion and waitForMessages refuse a wait over 45 seconds", async (t) => {
  const { cfg } = await setup(t);
  await assert.rejects(askQuestion(cfg, "Ship?", { seconds: 46 }), /Wait must be an integer from 0 to 45 seconds/);
  await assert.rejects(waitForMessages(cfg, { seconds: 46 }), /Wait must be an integer from 0 to 45 seconds/);
});

test("findAnswers: one answer per question in reply order, a skip, the choice label set, and the since window", async (t) => {
  const { cfg } = await setup(t);
  const asked = [
    { id: ID_A, askedAt: 1_700_000_100_000 },
    { id: ID_B, askedAt: 1_700_000_200_000 },
    { id: ID_C, askedAt: 1_700_000_300_000, questions: MULTI },
  ];
  const seen = [];
  const poll = async (c, topic, since) => {
    seen.push([topic, since]);
    return [
      { id: "1", message: `reply ${ID_A} yes` },
      { id: "2", message: JSON.stringify({ v: 1, kind: "approval-end", from: "operator", id: ID_B, reason: "skipped" }) },
      { id: "3", message: `reply ${ID_C} vue, react` },
      { id: "4", message: `reply ${ID_C} react` },
      { id: "5", message: `reply ${ID_A} later` },
    ];
  };
  assert.deepEqual(await findAnswers(cfg, asked, { poll }), [
    { id: ID_A, answer: "yes", messageId: "1" },
    { id: ID_B, skipped: true },
    { id: ID_C, answer: "Vue, React", messageId: "3" },
  ]);
  assert.deepEqual(seen, [[ALL, String(Math.floor(1_700_000_100_000 / 1000) - 60)]]);
});

test("approval end bytes: the stream path closes its card with the session and no owned flag", async (t) => {
  const { fake, cfg } = await setup(t, { AI_COLLAB_WIRE: "envelope" });
  const mode = () => ({ mode: "on", ts: 0 });
  const pending = decideApproval(cfg, { host: "claude", key: "permissionrequest", input: bash, signal: AbortSignal.abort(), mode });
  assert.deepEqual(await pending, {});
  const raw = fake.state.publishes.map((p) => p.message).find((m) => m.includes('"kind":"approval-end"'));
  const asked = await published(fake, "approval");
  assert.equal(endBytes(raw), `{"v":1,"kind":"approval-end","from":"claude","session":"${SESSION}","id":"${asked.id}","reason":"cancelled","ts":"T"}`);
});

test("approval end bytes: the owned runner envelope carries the session and owned:true", () => {
  const cfg = { peer: "claude", session: SESSION, wire: "envelope" };
  assert.equal(endBytes(approvalEndMessage(cfg, ID_A, "allowed")), `{"v":1,"kind":"approval-end","from":"claude","session":"${SESSION}","id":"${ID_A}","reason":"allowed","owned":true,"ts":"T"}`);
  assert.equal(endBytes(approvalEndMessage({ ...cfg, session: undefined }, ID_A, "allowed")), `{"v":1,"kind":"approval-end","from":"claude","id":"${ID_A}","reason":"allowed","owned":true,"ts":"T"}`);
  assert.equal(endBytes(approvalEndMessage({ ...cfg, session: "" }, ID_A, "allowed")), `{"v":1,"kind":"approval-end","from":"claude","session":"","id":"${ID_A}","reason":"allowed","owned":true,"ts":"T"}`);
});

test("approval end bytes: the limit card envelope has no session field", () => {
  const cfg = { peer: "claude", session: SESSION, wire: "envelope" };
  assert.equal(endBytes(limitEndMessage(cfg, ID_A, "answered")), `{"v":1,"kind":"approval-end","from":"claude","id":"${ID_A}","reason":"answered","ts":"T"}`);
});

test("approval end bytes: the AG-UI wire wraps each end in a CUSTOM event", () => {
  const cfg = { peer: "claude", session: SESSION, wire: "agui" };
  assert.equal(endBytes(limitEndMessage(cfg, ID_A, "answered")), `{"name":"ai-collab.approval-end","value":{"from":"claude","id":"${ID_A}","reason":"answered","ts":"T"},"timestamp":0,"type":"CUSTOM"}`);
  assert.equal(endBytes(approvalEndMessage(cfg, ID_A, "allowed")), `{"name":"ai-collab.approval-end","value":{"from":"claude","session":"${SESSION}","id":"${ID_A}","reason":"allowed","owned":true,"ts":"T"},"timestamp":0,"type":"CUSTOM"}`);
});
