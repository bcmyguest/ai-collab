// The Stop button rule (web/lib/session-state.js canStop): a running runner turn, or a working session that takes an interrupt.
import assert from "node:assert/strict";
import { test } from "node:test";
import { canStop } from "../web/lib/session-state.js";

const NOW = 1_800_000_000_000;
const working = { online: true, runningJobs: 1 };

test("a running runner-held turn can stop", () => {
  assert.equal(canStop({ id: "claude#a", runnerStatus: "running" }, NOW), true);
});

test("a working Codex or OpenCode session outside the runner can stop; a Claude one cannot", () => {
  assert.equal(canStop({ id: "opencode#a", harness: "opencode", ...working }, NOW), true);
  assert.equal(canStop({ id: "codex#a", harness: "codex", ...working }, NOW), true);
  assert.equal(canStop({ id: "claude#a", harness: "claude", ...working }, NOW), false);
});

test("a working runner-held session of any harness can stop", () => {
  assert.equal(canStop({ id: "claude#a", harness: "claude", runnerStatus: "idle", ...working }, NOW), true);
});

test("an idle session shows no Stop", () => {
  assert.equal(canStop({ id: "opencode#a", harness: "opencode", online: true }, NOW), false);
});
