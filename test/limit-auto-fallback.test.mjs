import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWireEnvelope } from "../lib/agui.mjs";
import { loadConfig } from "../lib/config.mjs";
import { alertLimit, fallbackChain, CURSOR_FALLBACK, OPENCODE_FALLBACK } from "../lib/limit-alert.ts";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const SESSION = "aabbccddeeff0011";
const LIMIT = { window: "five_hour", windowName: "5-hour", resetsAt: null, wording: true, verified: true, source: "test" };

function approvals(messages) {
  return messages.flatMap((message) => {
    try {
      const parsed = parseWireEnvelope(message);
      return parsed.kind === "approval" ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

async function setup(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "codex" });
  const cfg = loadConfig(env);
  return { env, cfg, sessionCfg: { ...cfg, peer: "codex", session: SESSION } };
}

test("fallbackChain tries the configured model, then Cursor, then the free model", () => {
  const chain = fallbackChain({
    harness: "codex",
    fallback: "opencode:opencode/deepseek-v4.1-flash-free",
    models: {},
    available: ["cursor", "opencode"],
  });
  assert.deepEqual(chain.map((item) => item.label), [
    `${OPENCODE_FALLBACK.harness}:${OPENCODE_FALLBACK.model}`,
    `${CURSOR_FALLBACK.harness}:${CURSOR_FALLBACK.model}`,
  ]);
  assert.deepEqual(fallbackChain({ harness: "cursor", fallback: "", models: {}, available: [] }).map((item) => item.harness), ["opencode"]);
});

test("a usage limit starts Cursor and does not ask", async (t) => {
  const { sessionCfg } = await setup(t);
  const calls = [];
  const sent = [];
  const start = async (_cfg, args) => {
    calls.push(args);
    return { status: "started", detail: "cursor started", session: "cursor#0123456789abcdef" };
  };
  const send = async (...args) => { sent.push(args[2]); };
  const result = await alertLimit(sessionCfg, {
    harness: "codex", limit: LIMIT, auto: true, start, send,
    fallback: "cursor:deepseek-v41-flash-1017-high",
    listed: async () => ({}), available: () => ["cursor", "opencode"],
  });
  assert.equal(result.status, "started");
  assert.equal(result.session, "cursor#0123456789abcdef");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].harness, "cursor");
  assert.equal(calls[0].model, "deepseek-v41-flash-1017-high");
  assert.equal(calls[0].place, "folder");
  assert.match(calls[0].prompt, /Do not ask which task to do/);
  assert.equal(approvals(sent).length, 0);
  assert.match(sent.join("\n"), /continued as cursor:deepseek-v41-flash-1017-high/);
  const again = await alertLimit(sessionCfg, {
    harness: "codex", limit: LIMIT, auto: true, start, send,
    fallback: "cursor:deepseek-v41-flash-1017-high",
    listed: async () => ({}), available: () => ["cursor", "opencode"],
  });
  assert.equal(again.status, "duplicate");
  assert.equal(calls.length, 1);
});

test("a failed Cursor start tries the free model without asking", async (t) => {
  const { sessionCfg } = await setup(t);
  const calls = [];
  const sent = [];
  const start = async (_cfg, args) => {
    calls.push(args.harness);
    if (args.harness === "cursor") return { status: "failed", detail: "cursor is limited" };
    return { status: "started", detail: "opencode started", session: "opencode#0123456789abcdef" };
  };
  const result = await alertLimit(sessionCfg, {
    harness: "codex", limit: { ...LIMIT, window: "weekly", windowName: "weekly" }, auto: true, start,
    send: async (...args) => { sent.push(args[2]); },
    fallback: "cursor:deepseek-v41-flash-1017-high",
    listed: async () => ({}), available: () => ["cursor", "opencode"],
  });
  assert.deepEqual(calls, ["cursor", "opencode"]);
  assert.equal(result.status, "started");
  assert.equal(result.session, "opencode#0123456789abcdef");
  assert.equal(approvals(sent).length, 0);
});
