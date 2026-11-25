// Pins today's limit classification and fallback chains before lib/limits owns them. Expected values were read from the code on feat/limits.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fallbackAttempts, limitFallback } from "../lib/builder.mjs";
import { fallbackChain, replacementOptions } from "../lib/limit-alert.mjs";
import { classifyLimit, limitFromRunError } from "../lib/limits.mjs";

const summary = (found) => found && { window: found.window, windowName: found.windowName, wording: found.wording, verified: found.verified };

// The builder's own cursor case: a stderr line the Cursor CLI prints, with the monthly reset it names.
const CURSOR_BUILDER_LINE = "ActionRequiredError: You've hit your usage limit. Your usage limits will reset when your monthly cycle ends on 12/18/2099.";

test("the builder's Cursor line is a limit with wording and no window", () => {
  assert.deepEqual(summary(limitFromRunError("cursor", CURSOR_BUILDER_LINE)), { window: null, windowName: null, wording: true, verified: false });
});

test("the builder's Cursor line carries no reset time: the monthly date is read by the builder only", () => {
  assert.equal(limitFromRunError("cursor", CURSOR_BUILDER_LINE).resetsAt, null);
});

test("a Cursor plan limit line is a limit", () => {
  assert.deepEqual(summary(limitFromRunError("cursor", "ActionRequiredError: You've reached your plan limit")), { window: null, windowName: null, wording: true, verified: false });
});

test("a Codex builder line with usage-limit wording is a limit", () => {
  assert.deepEqual(summary(limitFromRunError("codex", "error: Usage limit reached")), { window: null, windowName: null, wording: true, verified: false });
});

test("a Codex line with 'try again at' names the reset, a local clock time", () => {
  const found = limitFromRunError("codex", "error: try again at 1:14 PM usage limit");
  assert.equal(found.wording, true);
  assert.ok(Number.isFinite(found.resetsAt) && found.resetsAt > Date.now());
});

test("a Claude result error with usage-limit wording is a limit", () => {
  assert.deepEqual(summary(limitFromRunError("claude", "Claude AI usage limit reached|1760000000")), { window: null, windowName: null, wording: true, verified: false });
});

test("an OpenCode run error with HTTP 429 and no wording is a rate limit, not a plan limit", () => {
  assert.deepEqual(summary(limitFromRunError("opencode", "provider failed", { status: 429 })), { window: null, windowName: null, wording: false, verified: false });
});

test("a Claude rate_limit_event with a rejected 5-hour window is a verified limit", () => {
  const found = classifyLimit("claude", { kind: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 4_102_444_800 } });
  assert.equal(found.windowName, "5-hour");
  assert.equal(found.verified, true);
  assert.equal(found.resetsAt, 4_102_444_800_000);
});

// The chain each caller computes, for the defaults.json shapes the operator can write.
const MODELS = { claude: ["sonnet", "opus"], codex: ["gpt-5"], cursor: ["auto"], opencode: ["anthropic/claude-sonnet-4-5"] };
const SHAPES = [undefined, "nonsense", "codex:gpt-5", "opencode:opencode/deepseek-v4.1-flash-free", "cursor:deepseek-v41-flash-1017-high", "claude:opus"];
const AUTO = {
  undefined: ["cursor:deepseek-v41-flash-1017-high", "opencode:opencode/deepseek-v4.1-flash-free", "claude:sonnet", "cursor:auto"],
  nonsense: ["cursor:deepseek-v41-flash-1017-high", "opencode:opencode/deepseek-v4.1-flash-free", "claude:sonnet", "cursor:auto"],
  "codex:gpt-5": ["cursor:deepseek-v41-flash-1017-high", "opencode:opencode/deepseek-v4.1-flash-free", "claude:sonnet", "cursor:auto"],
  "opencode:opencode/deepseek-v4.1-flash-free": ["opencode:opencode/deepseek-v4.1-flash-free", "cursor:deepseek-v41-flash-1017-high", "claude:sonnet", "cursor:auto"],
  "cursor:deepseek-v41-flash-1017-high": ["cursor:deepseek-v41-flash-1017-high", "opencode:opencode/deepseek-v4.1-flash-free", "claude:sonnet", "cursor:auto"],
  "claude:opus": ["claude:opus", "cursor:deepseek-v41-flash-1017-high", "opencode:opencode/deepseek-v4.1-flash-free", "claude:sonnet"],
};
const MANUAL = {
  undefined: ["codex:gpt-5", "cursor:auto", "opencode:anthropic/claude-sonnet-4-5"],
  nonsense: ["codex:gpt-5", "cursor:auto", "opencode:anthropic/claude-sonnet-4-5"],
  "codex:gpt-5": ["codex:gpt-5", "cursor:auto", "opencode:anthropic/claude-sonnet-4-5"],
  "opencode:opencode/deepseek-v4.1-flash-free": ["opencode:opencode/deepseek-v4.1-flash-free", "codex:gpt-5", "cursor:auto", "opencode:anthropic/claude-sonnet-4-5"],
  "cursor:deepseek-v41-flash-1017-high": ["cursor:deepseek-v41-flash-1017-high", "codex:gpt-5", "cursor:auto", "opencode:anthropic/claude-sonnet-4-5"],
  "claude:opus": ["codex:gpt-5", "cursor:auto", "opencode:anthropic/claude-sonnet-4-5"],
};

for (const fallback of SHAPES) {
  const key = fallback ?? "undefined";
  test(`fallbackChain (auto) from codex for limitFallback ${key}`, () => {
    const labels = fallbackChain({ harness: "codex", model: "gpt-5", fallback, models: MODELS, available: ["claude", "cursor", "opencode"] }).map((p) => p.label);
    assert.deepEqual(labels, AUTO[key]);
  });
  test(`replacementOptions (manual card) from claude for limitFallback ${key}`, () => {
    const labels = replacementOptions({ harness: "claude", model: "opus", fallback, models: MODELS, available: ["codex", "cursor", "opencode"] }).map((p) => p.label);
    assert.deepEqual(labels, MANUAL[key]);
  });
}

// The builder's chain: defaults.json limitFallback, then Cursor DeepSeek, then the free OpenCode model; Codex is never a retry target.
function configDir(limitFallback) {
  const home = mkdtempSync(path.join(tmpdir(), "ai-collab-limits-char-"));
  mkdirSync(path.join(home, "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, "ai-collab", "defaults.json"), JSON.stringify(limitFallback === undefined ? {} : { limitFallback }));
  return { XDG_CONFIG_HOME: home };
}

const BUILDER_CHAIN = {
  undefined: [["cursor", "deepseek-v41-flash-1017-high"], ["opencode", "opencode/deepseek-v4.1-flash-free"]],
  nonsense: [["cursor", "deepseek-v41-flash-1017-high"], ["opencode", "opencode/deepseek-v4.1-flash-free"]],
  "codex:gpt-5": [["cursor", "deepseek-v41-flash-1017-high"], ["opencode", "opencode/deepseek-v4.1-flash-free"]],
  "opencode:opencode/deepseek-v4.1-flash-free": [["opencode", "opencode/deepseek-v4.1-flash-free"], ["cursor", "deepseek-v41-flash-1017-high"]],
  "cursor:deepseek-v41-flash-1017-high": [["cursor", "deepseek-v41-flash-1017-high"], ["opencode", "opencode/deepseek-v4.1-flash-free"]],
  "claude:opus": [["claude", "opus"], ["cursor", "deepseek-v41-flash-1017-high"], ["opencode", "opencode/deepseek-v4.1-flash-free"]],
};

for (const fallback of SHAPES) {
  const key = fallback ?? "undefined";
  test(`builder retry chain for limitFallback ${key} is today's list`, () => {
    const env = configDir(fallback);
    assert.deepEqual(fallbackAttempts(env).map((item) => [item.harness, item.model]), BUILDER_CHAIN[key]);
  });
}

test("builder limitFallback reads the configured harness:model and falls back to Cursor DeepSeek", () => {
  assert.deepEqual(limitFallback(configDir("claude:opus")), { harness: "claude", model: "opus" });
  assert.deepEqual(limitFallback(configDir("codex:gpt-5")), { harness: "cursor", model: "deepseek-v41-flash-1017-high" });
  assert.deepEqual(limitFallback(configDir(undefined)), { harness: "cursor", model: "deepseek-v41-flash-1017-high" });
});
