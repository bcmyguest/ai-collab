import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, isValidName, statusTopic, inboxTopic, broadcastTopic } from "../lib/config.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const base = { AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "alice" };

test("disabled by default: missing project or peer names the variables", (t) => {
  const HOME = tempDir(t, "ai-collab-home-"); // no projects.json from the real home
  const cfg = loadConfig({ HOME });
  assert.equal(cfg.enabled, false);
  assert.match(cfg.reason, /AI_COLLAB_PROJECT and AI_COLLAB_PEER/);
  assert.equal(loadConfig({ HOME, AI_COLLAB_PROJECT: "demo" }).enabled, false);
  assert.equal(loadConfig({ HOME, AI_COLLAB_PEER: "alice" }).enabled, false);
});

test("enabled with project and peer; default URL and scoped topics", () => {
  const cfg = loadConfig(base);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.url, "http://127.0.0.1:8794");
  assert.equal(statusTopic("demo"), "ai-collab-demo--status");
  assert.equal(inboxTopic("demo", "alice"), "ai-collab-demo--to--alice");
  assert.equal(broadcastTopic("demo"), "ai-collab-demo--to--all");
});

test("URL is normalised and must be http(s)", () => {
  assert.equal(loadConfig({ ...base, AI_COLLAB_URL: "http://ntfy.internal:8794/" }).url, "http://ntfy.internal:8794");
  const bad = loadConfig({ ...base, AI_COLLAB_URL: "ftp://x" });
  assert.equal(bad.enabled, false);
  assert.match(bad.reason, /http or https/);
  assert.equal(loadConfig({ ...base, AI_COLLAB_URL: "not a url" }).enabled, false);
});

test("names are DNS-friendly and cannot collide across project/peer pairs", () => {
  assert.equal(isValidName("alice"), true);
  assert.equal(isValidName("a-b-c"), true);
  for (const bad of ["Alice", "a_b", "-a", "a-", "a--b", "a".repeat(25), "", "a.b"]) {
    assert.equal(isValidName(bad), false, bad);
  }
  assert.equal(loadConfig({ ...base, AI_COLLAB_PEER: "all" }).enabled, false);
  assert.equal(loadConfig({ ...base, AI_COLLAB_PROJECT: "a--b" }).enabled, false);
});

test("longest possible topic stays within ntfy's 64-character limit", () => {
  const p = "a".repeat(24);
  for (const t of [statusTopic(p), inboxTopic(p, p), broadcastTopic(p)]) {
    assert.ok(t.length <= 64, `${t} is ${t.length} chars`);
    assert.match(t, /^[a-z0-9-]+$/);
  }
});

test("AI_COLLAB_PEERS is parsed and deduplicated; invalid entries disable with a reason", () => {
  const ok = loadConfig({ ...base, AI_COLLAB_PEERS: "alice, bob,bob,carol" });
  assert.deepEqual(ok.peers, ["alice", "bob", "carol"]);
  assert.equal(ok.enabled, true);
  const bad = loadConfig({ ...base, AI_COLLAB_PEERS: "bob,Eve Mallory" });
  assert.equal(bad.enabled, false);
  assert.match(bad.reason, /AI_COLLAB_PEERS has invalid name/);
});

test("timeouts are clamped", () => {
  assert.equal(loadConfig({ ...base, AI_COLLAB_TIMEOUT_MS: "1" }).timeoutMs, 200);
  assert.equal(loadConfig({ ...base, AI_COLLAB_TIMEOUT_MS: "nope" }).timeoutMs, 2000);
  assert.equal(loadConfig({ ...base, AI_COLLAB_POLL_INTERVAL_MS: "0" }).pollIntervalMs, 0);
});
