// A Codex builder's usage-limit retry chain is the operator's configured chain (lib/limits.ts fallbackChain).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fallbackAttempts } from "../lib/builder.mjs";

function configDir(limitFallback) {
  const home = mkdtempSync(path.join(tmpdir(), "ai-collab-builder-chain-"));
  mkdirSync(path.join(home, "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, "ai-collab", "defaults.json"), JSON.stringify({ limitFallback }));
  return { XDG_CONFIG_HOME: home };
}

test("a configured Codex model other than the stopped one is the first retry", () => {
  const chain = fallbackAttempts(configDir("codex:gpt-5-alt"), { model: "gpt-6.2-sol" });
  assert.deepEqual(chain[0], { harness: "codex", model: "gpt-5-alt" });
});

test("a Codex builder's retry offers another available harness with a listed model", () => {
  const chain = fallbackAttempts(configDir(undefined), { model: "gpt-6.2-sol", available: ["claude"], models: { claude: ["haiku"] } });
  assert.ok(chain.some((item) => item.harness === "claude" && item.model === "haiku"), JSON.stringify(chain));
});
