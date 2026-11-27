import { parseWireEnvelope } from "../lib/agui.mjs";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, after } from "node:test";
import { contextUsage, readContext, recordInstructions, reportContext } from "../lib/usage.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const dir = tempDir({ after }, "ai-collab-context-");
const cfg = { enabled: true, stateDir: join(dir, "state"), project: "demo", peer: "alice", session: "aabbccddeeff0123" };
const stateFile = join(cfg.stateDir, "demo", "sessions", "alice", "aabbccddeeff0123.context.json");
const claudeFile = (name) => join(dir, name);

test("recordInstructions stores the loaded file, memory type and load reason", async () => {
  assert.equal(await recordInstructions(cfg, { file_path: "/w/CLAUDE.md", memory_type: "Project", load_reason: "session_start" }), true);
  assert.equal(await recordInstructions(cfg, { file_path: "/w/sub/AGENTS.md", memory_type: "Local", load_reason: "nested_traversal" }), true);
  const { files } = readContext(cfg);
  assert.deepEqual(files.map(f => [f.path, f.memory, f.load]), [["/w/CLAUDE.md", "Project", "session_start"], ["/w/sub/AGENTS.md", "Local", "nested_traversal"]]);
});

test("a later load of the same path replaces its entry", async () => {
  // A session_start reload keeps the nested entry; a compact load would drop it (test/context-compact.test.mjs).
  await recordInstructions(cfg, { file_path: "/w/CLAUDE.md", memory_type: "Project", load_reason: "session_start" });
  const { files } = readContext(cfg);
  assert.equal(files.length, 2);
  assert.equal(files.find(f => f.path === "/w/CLAUDE.md").load, "session_start");
});

test("recordInstructions rejects a relative path, an unknown memory type or load reason", async () => {
  assert.equal(await recordInstructions(cfg, { file_path: "CLAUDE.md", memory_type: "Project", load_reason: "session_start" }), false);
  assert.equal(await recordInstructions(cfg, { file_path: "/w/x.md", memory_type: "Cloud", load_reason: "session_start" }), false);
  assert.equal(await recordInstructions(cfg, { file_path: "/w/x.md", memory_type: "User", load_reason: "startup" }), false);
  assert.equal(await recordInstructions({ ...cfg, session: "" }, { file_path: "/w/x.md", memory_type: "User", load_reason: "include" }), false);
  assert.equal(readContext(cfg).files.length, 2);
});

test("reportContext persists the token count and window without changing the alert", async () => {
  const sent = [];
  const send = async (_cfg, topic, message) => { sent.push(parseWireEnvelope(message)); };
  assert.deepEqual(await reportContext(cfg, 12_000, { send, window: 258_400 }), { alerted: false });
  const view = readContext(cfg);
  assert.equal(view.tokens, 12_000);
  assert.equal(view.window, 258_400);
  assert.ok(Number.isFinite(view.at));
  assert.equal(sent.length, 0);

  assert.equal((await reportContext(cfg, 200_001, { send, window: 258_400 })).alerted, true);
  assert.equal(sent.length, 1);
  assert.equal(readContext(cfg).tokens, 200_001);
  assert.equal(readContext(cfg).files.length, 2, "tokens do not drop the instruction files");
});

test("reportContext without a window stores null and keeps the instruction files", async () => {
  await reportContext(cfg, 5_000);
  const saved = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(saved.contextWindow, null);
  assert.equal(readContext(cfg).window, null);
  assert.equal(readContext(cfg).files.length, 2);
});

test("readContext is empty for a session without state", () => {
  assert.deepEqual(readContext({ ...cfg, session: "0000000000000000" }), { tokens: null, window: null, at: null, files: [] });
});

test("contextUsage reads Codex's window from the token_count event", () => {
  const rollout = claudeFile("rollout.jsonl");
  writeFileSync(rollout, [
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 1000 }, model_context_window: 100 } } }),
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 11798 }, model_context_window: 258400 } } }),
    "",
  ].join("\n"));
  assert.deepEqual(contextUsage("codex", { transcript_path: rollout }), { tokens: 11798, window: 258400 });
});

test("contextUsage reports no window for Claude, Cursor and OpenCode", () => {
  const transcript = claudeFile("claude.jsonl");
  mkdirSync(dir, { recursive: true });
  writeFileSync(transcript, JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 5 } } }) + "\n");
  assert.deepEqual(contextUsage("claude", { transcript_path: transcript }), { tokens: 12, window: null });
  assert.deepEqual(contextUsage("cursor", { context_tokens: 210_000 }), { tokens: 210_000, window: null });
  assert.deepEqual(contextUsage("opencode", { context_tokens: 7 }), { tokens: 7, window: null });
});
