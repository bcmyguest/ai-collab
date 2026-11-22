import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig } from "../lib/config.mjs";
import { claimInbox } from "../lib/inbox.mjs";
import { contextTokens, reportContext } from "../lib/usage.mjs";

const dir = mkdtempSync(join(tmpdir(), "ai-collab-usage-"));
function transcript(name, entries) {
  const file = join(dir, name + ".jsonl");
  writeFileSync(file, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

test("context tokens come from each harness's own latest counter", () => {
  const claude = transcript("claude", [
    { type: "assistant", message: { usage: { input_tokens: 9, cache_read_input_tokens: 9, cache_creation_input_tokens: 9 } } },
    { type: "assistant", message: { usage: { input_tokens: 2, cache_read_input_tokens: 93307, cache_creation_input_tokens: 431, output_tokens: 305 } } },
    { type: "user", message: { content: "later" } },
  ]);
  assert.equal(contextTokens("claude", { transcript_path: claude }), 93740);
  const codex = transcript("codex", [
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 5 } } } },
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 78606 } } } },
    { type: "event_msg", payload: { type: "token_count", info: null } },
  ]);
  assert.equal(contextTokens("codex", { transcript_path: codex }), 78606);
  assert.equal(contextTokens("cursor", { context_tokens: 210000 }), 210000);
  assert.equal(contextTokens("cursor", { context_tokens: "210000" }), null);
  assert.equal(contextTokens("claude", { transcript_path: join(dir, "missing.jsonl") }), null);
  assert.equal(contextTokens("claude", { transcript_path: "/etc/passwd" }), null);
});

test("one alert per crossing above 200,000; failed publish retries; a drop re-arms", { timeout: 10000 }, async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "alice" });
  const cfg = loadConfig(env, { host: "claude", session: "aabbccddeeff0123" });
  const alerts = () => fake.state.publishes.filter(p => JSON.parse(p.message)?.kind === "alert");

  assert.equal((await reportContext(cfg, 200_000)).alerted, false);
  assert.equal(alerts().length, 0);

  fake.state.failNext = 1;
  await assert.rejects(reportContext(cfg, 200_001));
  assert.equal(alerts().length, 0);

  assert.equal((await reportContext(cfg, 200_001)).alerted, true);
  const [alert] = alerts();
  assert.equal(alert.topic, "ai-collab-demo--to--all");
  assert.match(alert.title, /alice#aabbccddeeff0123 context 200001 tokens/);
  assert.deepEqual(JSON.parse(alert.message), {
    v: 1, kind: "alert", from: "alice", session: "aabbccddeeff0123", contextTokens: 200001, threshold: 200000,
  });

  assert.equal((await reportContext(cfg, 250_000)).alerted, false);
  assert.equal(alerts().length, 1);
  assert.equal((await reportContext(cfg, 200_000)).alerted, false);
  assert.equal((await reportContext(cfg, 200_001)).alerted, true);
  assert.equal(alerts().length, 2);

  const bob = loadConfig(peerEnv(fake, { peer: "bob" }), { host: "codex" });
  assert.deepEqual(await claimInbox(bob), []);
});
