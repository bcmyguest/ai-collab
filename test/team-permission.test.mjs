import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DotError, parseDot, serializeDot } from "../lib/dot.mjs";
import { claudePermissionFor } from "../lib/start.mjs";

const TEAM = `digraph "duo" {
  "lead" [agent="codex", prompt="Scope it.", code_mode="off"];
  "doer" [agent="claude", prompt="Do it.", code_mode=on];
  "lead" -> "doer" [on="scope"];
  "doer" -> "done" [on="finished"];
}`;
const withPermission = (value) => TEAM.replace("digraph \"duo\" {", `digraph "duo" {\n  graph [permission="${value}"];`);
const cfg = { project: "demo", stateDir: mkdtempSync(path.join(os.tmpdir(), "team-perm-")) };

test("the team.dot permission attribute parses and round-trips through serializeDot", () => {
  const team = parseDot(withPermission("dontAsk"));
  assert.equal(team.permission, "dontAsk");
  assert.match(serializeDot(team), /graph \[permission="dontAsk"\]/);
  assert.equal(parseDot(serializeDot(team)).permission, "dontAsk");
  assert.equal("permission" in parseDot(TEAM), false, "a team without the attribute has none");
});

test("an invalid team.dot permission is refused with the valid values and the line", () => {
  assert.throws(() => parseDot(withPermission("yolo")), (error) => error instanceof DotError
    && /claudePermissionMode must be one of auto-afk, inherit, acceptEdits, auto, bypassPermissions, default, dontAsk, plan; got "yolo"/.test(error.message)
    && error.line === 2);
});

// Precedence for team, pattern and continuation starts: instance, then team, then auto.
test("precedence: instance over team over auto", () => {
  const rows = [
    [undefined, undefined, "auto"],
    [undefined, "acceptEdits", "acceptEdits"],
    ["dontAsk", "acceptEdits", "dontAsk"],
    ["inherit", "acceptEdits", undefined],
    ["default", undefined, "default"],
  ];
  for (const [instance, team, flag] of rows) {
    assert.deepEqual(claudePermissionFor("claude", cfg, {}, { setting: instance ?? team ?? "auto" }), { flag }, `instance=${instance} team=${team}`);
  }
});

test("an invalid instance or team setting is refused, and other harnesses get none", () => {
  assert.match(claudePermissionFor("claude", cfg, {}, { setting: "yolo" }).error, /claudePermissionMode must be one of .* got "yolo"/);
  assert.deepEqual(claudePermissionFor("codex", cfg, {}, { setting: "dontAsk" }), {});
});

test("bypassPermissions is refused outside OpenShell, unless the host agent is allowed", () => {
  const refused = claudePermissionFor("claude", cfg, {}, { setting: "bypassPermissions" });
  assert.match(refused.error, /bypassPermissions runs only in openshell; set AI_COLLAB_ALLOW_HOST_AGENT=1/);
  assert.deepEqual(claudePermissionFor("claude", cfg, {}, { setting: "bypassPermissions", sandboxed: true }), { flag: "bypassPermissions" });
  assert.deepEqual(claudePermissionFor("claude", cfg, { AI_COLLAB_ALLOW_HOST_AGENT: "1" }, { setting: "bypassPermissions" }), { flag: "bypassPermissions" });
});
