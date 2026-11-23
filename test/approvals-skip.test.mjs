// An operator Skip ends the hook's wait with no decision, so the harness's own terminal prompt takes over; nothing allows or denies.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseWireEnvelope } from "../lib/agui.mjs";
import { loadConfig } from "../lib/config.mjs";
import { END_REASONS, decideApproval, decideQuestion } from "../lib/approvals.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const ALL = "ai-collab-demo--to--all";
const SESSION = "aabbccddeeff0011";
const QUESTIONS = [{ question: "Which framework?", header: "Framework", multiSelect: false, options: [{ label: "React" }, { label: "Vue" }] }];

const setMode = (fake, mode) => fake.inject(ALL, JSON.stringify({ v: 1, kind: "mode", from: "operator", mode, ts: Date.now() }));
const skip = (fake, id, from = "operator") => fake.inject(ALL, JSON.stringify({ v: 1, kind: "approval-end", from, id, reason: "skipped", ts: new Date().toISOString() }));
const envelopes = (fake, kind) => fake.state.publishes.map((p) => { try { return parseWireEnvelope(p.message); } catch { return null; } }).filter((m) => m?.kind === kind);

async function published(fake) {
  for (let i = 0; i < 200; i++) {
    const found = envelopes(fake, "approval")[0];
    if (found) return found;
    await delay(10);
  }
  throw new Error("no approval published");
}

async function setup(t, extra = {}) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "claude", AI_COLLAB_PEERS: "claude,codex,cursor", ...extra });
  return { fake, cfg: { ...loadConfig(env), session: SESSION } };
}

test("skipped is an end reason", () => {
  assert.ok(END_REASONS.includes("skipped"));
});

test("an operator skip of a permission request returns no decision and publishes no second end", async (t) => {
  const { fake, cfg } = await setup(t);
  setMode(fake, "on");
  const pending = decideApproval(cfg, { host: "claude", key: "permissionrequest", input: { tool_name: "Bash", tool_input: { command: "make" } } });
  skip(fake, (await published(fake)).id);
  assert.deepEqual(await pending, {});
  await delay(50);
  assert.equal(envelopes(fake, "approval-end").length, 0, "the operator's skip already closed the card");
});

test("a Cursor skip returns the no-decision output, which asks in Cursor", async (t) => {
  const { fake, cfg } = await setup(t);
  setMode(fake, "on");
  const cursor = decideApproval({ ...cfg, peer: "cursor" }, { host: "cursor", key: "beforeshellexecution", input: { command: "ls" }, mode: () => ({ mode: "on", ts: 0 }) });
  skip(fake, (await published(fake)).id);
  assert.deepEqual(await cursor, { permission: "ask" });
});

test("a skipped AskUserQuestion falls back to the terminal dialog", async (t) => {
  const { fake, cfg } = await setup(t);
  setMode(fake, "on");
  const pending = decideQuestion(cfg, { input: { tool_name: "AskUserQuestion", tool_use_id: "tu-1", tool_input: { questions: QUESTIONS } } });
  skip(fake, (await published(fake)).id);
  assert.deepEqual(await pending, {});
});

test("a skip from an agent, or for another id, does not end the wait", async (t) => {
  const { fake, cfg } = await setup(t, { AI_COLLAB_APPROVAL_S: "1" });
  setMode(fake, "on");
  const pending = decideApproval(cfg, { host: "claude", key: "permissionrequest", input: { tool_name: "Bash", tool_input: { command: "make" } } });
  const { id } = await published(fake);
  skip(fake, id, "codex");
  skip(fake, "ffffffffffff");
  assert.deepEqual(await pending, {});
  assert.deepEqual(envelopes(fake, "approval-end").map((m) => m.reason), ["timeout"], "the wait ran to its deadline");
});
