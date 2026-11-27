import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { START_DEFAULT, startDefaultSetting } from "../lib/config.ts";
import { startDefaultDraft } from "../web/lib/start-default.js";
import { tempDir } from "./helpers/tmp.mjs";

function envWithDefaults(value) {
  const xdg = tempDir({ after }, "start-default-xdg-");
  mkdirSync(path.join(xdg, "ai-collab"), { recursive: true });
  if (value !== undefined) writeFileSync(path.join(xdg, "ai-collab", "defaults.json"), JSON.stringify({ startDefault: value }));
  return { XDG_CONFIG_HOME: xdg };
}

test("the built-in default is cursor on deepseek, and defaults.json startDefault replaces it", () => {
  assert.equal(START_DEFAULT, "cursor:deepseek-v41-flash-1017-high");
  assert.deepEqual(startDefaultSetting(envWithDefaults()), { harness: "cursor", model: "deepseek-v41-flash-1017-high" });
  assert.deepEqual(startDefaultSetting(envWithDefaults("codex:gpt-5-codex")), { harness: "codex", model: "gpt-5-codex" });
});

test("an invalid startDefault falls back to the built-in default", () => {
  assert.equal(startDefaultSetting(envWithDefaults("not a default!")).harness, "cursor");
  assert.equal(startDefaultSetting(envWithDefaults(42)).harness, "cursor");
});

test("the draft names the configured harness and model when cursor is startable and lists the model", () => {
  const setting = { harness: "cursor", model: "deepseek-v41-flash-1017-high" };
  const models = { cursor: ["deepseek-v41-flash-1017-high", "other"] };
  assert.equal(startDefaultDraft({ startable: ["claude", "cursor"], models, setting }), "@cursor:deepseek-v41-flash-1017-high ");
});

test("the draft keeps the configured model while the model list has not loaded", () => {
  const setting = { harness: "cursor", model: "deepseek-v41-flash-1017-high" };
  assert.equal(startDefaultDraft({ startable: ["cursor"], models: {}, setting }), "@cursor:deepseek-v41-flash-1017-high ");
});

test("the draft falls back to the first available harness when cursor or its model is missing", () => {
  const setting = { harness: "cursor", model: "deepseek-v41-flash-1017-high" };
  assert.equal(startDefaultDraft({ startable: ["claude", "codex"], models: {}, setting }), "@claude ");
  assert.equal(startDefaultDraft({ startable: ["cursor", "claude"], models: { cursor: ["other"] }, setting }), "@cursor ");
  assert.equal(startDefaultDraft({ startable: ["cursor"], models: { cursor: ["other"] }, setting: { harness: "cursor", model: "missing" } }), "@cursor ");
});

test("the draft is empty when no harness can start", () => {
  assert.equal(startDefaultDraft({ startable: [], models: {}, setting: { harness: "cursor", model: "x" } }), "");
});
