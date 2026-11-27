import { parseWireEnvelope } from "../lib/agui.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../lib/config.ts";
import { MESSAGE_MAX_BYTES } from "../lib/config.ts";
import { askQuestion, openQuestions, waitRequestedAt } from "../lib/questions.ts";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const ALL = "ai-collab-demo--to--all";
const SESSION = "aabbccddeeff0011";

const envelopes = (fake, kind) => fake.state.publishes.map((p) => { try { return { ...parseWireEnvelope(p.message), topic: p.topic, title: p.title }; } catch { return null; } })
  .filter((m) => m?.kind === kind);

async function published(fake, kind) {
  for (let i = 0; i < 200; i++) {
    const found = envelopes(fake, kind)[0];
    if (found) return found;
    await delay(10);
  }
  throw new Error(`no ${kind} envelope published`);
}

async function setup(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "alice" });
  return { fake, env, cfg: { ...loadConfig(env), session: SESSION } };
}

test("ask_question with options publishes a choice card and returns the chosen labels", async (t) => {
  const { fake, cfg } = await setup(t);
  const pending = askQuestion(cfg, "Which tests?", {
    seconds: 5, intervalMs: 20, harness: "claude", multiSelect: true, choices: [{ label: "Unit" }, { label: "E2E", description: "Browser" }],
  });
  const asked = await published(fake, "approval");
  assert.deepEqual(asked.questions, [{ question: "Which tests?", header: "", multiSelect: true, options: [{ label: "Unit" }, { label: "E2E", description: "Browser" }] }]);
  assert.equal(asked.tool, "ask_question");
  assert.equal(asked.harness, "claude");
  assert.equal(asked.expiresAt, 0);
  fake.inject(ALL, `reply ${asked.id} Unit, Other`);
  assert.deepEqual(await pending, { id: asked.id, status: "answered", answer: "Unit, Other", selected: ["Unit", "Other"], source: "unverified channel broadcast" });
});

test("a single choice answers with JSON or plain text and returns one label", async (t) => {
  const { fake, cfg } = await setup(t);
  const pending = askQuestion(cfg, "Which framework?", { seconds: 5, intervalMs: 20, choices: [{ label: "React" }, { label: "Vue" }] });
  const asked = await published(fake, "approval");
  fake.inject(ALL, `reply ${asked.id} ${JSON.stringify({ "Which framework?": "vue" })}`);
  assert.deepEqual((await pending).selected, ["Vue"]);
});

test("invalid choices are refused before anything is published", async (t) => {
  const { fake, cfg } = await setup(t);
  const seconds = 0;
  await assert.rejects(askQuestion(cfg, "Q", { seconds, choices: [{ label: "A" }] }), /2 to 6 choices/);
  await assert.rejects(askQuestion(cfg, "Q", { seconds, multiSelect: true }), /needs options/);
  await assert.rejects(askQuestion(cfg, "Q", { seconds, choices: [{ label: "A" }, { label: "a" }] }), /unique/);
  await assert.rejects(askQuestion(cfg, "Q", { seconds, multiSelect: true, choices: [{ label: "A, B" }, { label: "C" }] }), /commas/);
  await assert.rejects(askQuestion(cfg, "Q", { seconds, choices: [{ label: "A", description: "x".repeat(301) }, { label: "B" }] }), /300/);
  assert.equal(envelopes(fake, "approval").length, 0);
  assert.equal(envelopes(fake, "approval-view").length, 0);
});

test("MCP ask_question takes options and multi_select over stdio and returns the chosen labels", { timeout: 15000 }, async (t) => {
  const { fake, env, cfg } = await setup(t);
  const script = fileURLToPath(new URL("../scripts/ai-collab-mcp.mjs", import.meta.url));
  const child = spawn(process.execPath, [script, "claude"], { env, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "ask_question", arguments: { question: "Which tests?", wait_seconds: 5, session: SESSION, options: [{ label: "Unit" }, { label: "E2E" }], multi_select: true } },
  }) + "\n");
  const asked = await published(fake, "approval");
  assert.equal(asked.questions[0].multiSelect, true);
  fake.inject(ALL, `reply ${asked.id} ${JSON.stringify({ "Which tests?": "E2E, Unit" })}`);
  const result = JSON.parse(JSON.parse((await lines.next()).value).result.content[0].text);
  assert.deepEqual(result, { id: asked.id, status: "answered", answer: "E2E, Unit", selected: ["E2E", "Unit"], source: "unverified channel broadcast" });
  assert.deepEqual(openQuestions(cfg), []);
  assert.equal(waitRequestedAt(cfg), 0);
});

test("ask_question returns skipped and clears the wait when the operator skips a choice", async (t) => {
  const { fake, cfg } = await setup(t);
  const pending = askQuestion(cfg, "Which framework?", {
    seconds: 5, intervalMs: 20, important: true, choices: [{ label: "React" }, { label: "Vue" }],
  });
  const { id } = await published(fake, "approval");
  fake.inject(ALL, JSON.stringify({ v: 1, kind: "approval-end", from: "operator", id, reason: "skipped" }));
  assert.deepEqual(await pending, { id, status: "skipped" });
  assert.deepEqual(openQuestions(cfg), []);
  assert.equal(waitRequestedAt(cfg), 0);
});

test("an oversized choice card shrinks its descriptions to fit MESSAGE_MAX_BYTES", async (t) => {
  const { fake, cfg } = await setup(t);
  const choices = ["A", "B", "C", "D", "E", "F"].map((c) => ({ label: `${c}${"é".repeat(90)}`, description: "é".repeat(300) }));
  const pending = askQuestion(cfg, "é".repeat(500), { seconds: 5, intervalMs: 20, choices });
  const asked = await published(fake, "approval");
  const [card] = fake.state.publishes;
  assert.ok(Buffer.byteLength(card.message) <= MESSAGE_MAX_BYTES, `card is ${Buffer.byteLength(card.message)} bytes`);
  fake.inject(ALL, `reply ${asked.id} ${choices[0].label}`);
  assert.equal((await pending).status, "answered");
});
