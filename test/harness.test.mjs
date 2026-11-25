import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { agentHarness } from "../lib/agent-guard.mjs";
import { limitFallback } from "../lib/builder.mjs";
import { loadConfig, START_DEFAULT, startDefaultSetting } from "../lib/config.mjs";
import { CURSOR_FALLBACK } from "../lib/limit-alert.mjs";
import { FALLBACK_MODEL, formatHarnessModel, harnessOfBinary, parseHarnessModel } from "../lib/harness.ts";
import { getPattern, listPatterns } from "../lib/patterns.mjs";
import { harnessOfCommand } from "../lib/schedule-session.mjs";
import { parseMember } from "../lib/teams.mjs";

function withDefaults(value) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-harness-"));
  mkdirSync(path.join(home, "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, "ai-collab", "defaults.json"), JSON.stringify(value));
  return { home, env: { XDG_CONFIG_HOME: home, HOME: home } };
}

test("both binary maps resolve the same names to the same harness", () => {
  for (const [binary, harness] of [["agent", "cursor"], ["cursor-agent", "cursor"], ["claude", "claude"], ["codex", "codex"], ["opencode", "opencode"]]) {
    assert.equal(harnessOfBinary(binary), harness);
    assert.equal(agentHarness([`/usr/bin/${binary}`, "-p"]), harness);
    assert.equal(harnessOfCommand([binary, "-p"]), harness);
  }
});

test("the binary map rejects wrappers and prototype names", () => {
  for (const name of ["npx", "sh", "gemini", "constructor", "toString", ""]) {
    assert.equal(harnessOfBinary(name), undefined);
    assert.equal(agentHarness([name]), "");
    assert.equal(harnessOfCommand([name]), "");
  }
});

test("parseHarnessModel accepts a bare harness with an empty model", () => {
  assert.deepEqual(parseHarnessModel("claude"), { harness: "claude", model: "" });
  assert.deepEqual(parseHarnessModel("codex"), { harness: "codex", model: "" });
});

test("parseHarnessModel accepts harness:model with each harness's model shape", () => {
  assert.deepEqual(parseHarnessModel("cursor:deepseek-v41-flash-1017-high"), { harness: "cursor", model: "deepseek-v41-flash-1017-high" });
  assert.deepEqual(parseHarnessModel("codex:gpt-5-codex"), { harness: "codex", model: "gpt-5-codex" });
  assert.deepEqual(parseHarnessModel("claude:claude-haiku-5-5"), { harness: "claude", model: "claude-haiku-5-5" });
  assert.deepEqual(parseHarnessModel("opencode:openai/gpt-5"), { harness: "opencode", model: "openai/gpt-5" });
  assert.deepEqual(parseHarnessModel("opencode:opencode/deepseek-v4.1-flash-free"), { harness: "opencode", model: "opencode/deepseek-v4.1-flash-free" });
  assert.deepEqual(parseHarnessModel("cursor:a:b"), { harness: "cursor", model: "a:b" });
});

test("parseHarnessModel rejects unknown harnesses, empty or malformed models and non-strings", () => {
  for (const text of ["", "mallory", "gemini:x", "Claude", "claude:", "cursor:", "cursor:bad model", "cursor:-x", "not a default!", "opencode:gpt-5", undefined, 42, null]) {
    assert.equal(parseHarnessModel(text), null, String(text));
  }
});

test("formatHarnessModel inverts parseHarnessModel", () => {
  assert.equal(formatHarnessModel({ harness: "claude", model: "" }), "claude");
  assert.equal(formatHarnessModel({ harness: "cursor", model: "x" }), "cursor:x");
  assert.equal(formatHarnessModel(parseHarnessModel("opencode:openai/gpt-5")), "opencode:openai/gpt-5");
  assert.equal(parseMember("opencode:openai/gpt-5"), "opencode:openai/gpt-5");
});

test("the fallback model is one constant that every built-in default reuses", () => {
  assert.equal(FALLBACK_MODEL, "deepseek-v41-flash-1017-high");
  assert.equal(START_DEFAULT, `cursor:${FALLBACK_MODEL}`);
  assert.deepEqual(CURSOR_FALLBACK, { harness: "cursor", model: FALLBACK_MODEL });
});

test("a stale team with an unparseable member is marked invalid and breaks no other pattern", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-stale-team-"));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };
  const root = path.join(home, "repo");
  mkdirSync(root);
  mkdirSync(path.join(env.XDG_CONFIG_HOME, "ai-collab"), { recursive: true });
  writeFileSync(path.join(env.XDG_CONFIG_HOME, "ai-collab", "projects.json"), JSON.stringify([
    { root, project: "demo", url: "http://127.0.0.1:9", peers: "claude,codex" },
  ]));
  writeFileSync(path.join(env.XDG_CONFIG_HOME, "ai-collab", "teams.json"), JSON.stringify({ old: ["gemini", "cursor:auto"] }));
  const cfg = loadConfig({ ...env, AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "operator" });
  try {
    const patterns = listPatterns(cfg, env);
    assert.match(patterns.old.invalid, /gemini/);
    assert.deepEqual(patterns.old.roles, []);
    assert.equal(getPattern(cfg, "review", env).name, "review");
    assert.throws(() => getPattern(cfg, "old", env), /invalid/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("startDefault and limitFallback keep their built-in defaults for invalid values", () => {
  const bad = withDefaults({ startDefault: "gemini:x", limitFallback: "codex:gpt-5" });
  try {
    assert.deepEqual(startDefaultSetting(bad.env), { harness: "cursor", model: FALLBACK_MODEL });
    assert.deepEqual(limitFallback(bad.env), { harness: "cursor", model: FALLBACK_MODEL });
  } finally {
    rmSync(bad.home, { recursive: true, force: true });
  }
});
