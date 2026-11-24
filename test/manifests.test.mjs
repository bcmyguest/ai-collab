import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));

test("all three harness manifests parse and point at existing hook files", () => {
  const pairs = [
    [".claude-plugin/plugin.json", "hooks"],
    [".codex-plugin/plugin.json", "hooks"],
  ];
  for (const [manifest, key] of pairs) {
    const m = read(manifest);
    assert.equal(m.name, "ai-collab", manifest);
    assert.ok(fs.existsSync(path.join(ROOT, m[key])), `${manifest} -> ${m[key]}`);
  }
  // Cursor's CLI skips most plugin hooks, so the installer writes hooks/cursor-hooks.json into ~/.cursor/hooks.json.
  assert.equal(read(".cursor-plugin/plugin.json").hooks, undefined);
  assert.equal(read(".cursor-plugin/plugin.json").name, "ai-collab");
  assert.equal(read(".codex-plugin/plugin.json").skills, "./skills/");
  assert.ok(fs.existsSync(path.join(ROOT, "skills/ai-collab/SKILL.md")));
});

test("hook configs reference the wrappers and scripts that exist", () => {
  const claude = read("hooks/hooks.json").hooks;
  assert.deepEqual(Object.keys(claude).sort(), ["InstructionsLoaded", "MessageDisplay", "Notification", "PermissionRequest", "PostCompact", "PostModelSwitch", "PostToolUse", "PostToolUseFailure", "PreCompact", "PreToolUse",
    "SessionEnd", "SessionStart", "Stop", "StopFailure", "SubagentStart", "SubagentStop", "UserPromptSubmit"]);
  const codex = read("hooks/codex-hooks.json").hooks;
  assert.deepEqual(Object.keys(codex).sort(), ["PermissionRequest", "PostToolUse", "PreCompact", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "SubagentStart", "SubagentStop", "UserPromptSubmit"]);
  const cursor = read("hooks/cursor-hooks.json").hooks;
  assert.deepEqual(Object.keys(cursor).sort(), ["afterAgentResponse", "beforeReadFile", "beforeShellExecution", "beforeSubmitPrompt", "postToolUse", "postToolUseFailure",
    "preCompact", "preToolUse", "sessionEnd", "sessionStart", "stop"]);
  for (const event of ["beforeReadFile", "beforeShellExecution", "preToolUse"]) assert.match(cursor[event][0].command, /--read-gate --host cursor$/);
  assert.equal(cursor.afterAgentThought, undefined, "thinking is never published");
  // beforeSubmitPrompt is activity-only: its documented output is { continue }, not additional_context.
  assert.match(cursor.beforeSubmitPrompt[0].command, /--activity --host cursor$/);
  for (const name of ["PreToolUse", "MessageDisplay", "SubagentStart", "SubagentStop", "PreCompact"]) assert.equal(claude[name][0].hooks[0].async, true, `${name} must not block Claude`);

  const commands = [
    ...Object.values(claude).flat().flatMap((g) => g.hooks.map((h) => h.command)),
    ...Object.values(codex).flat().flatMap((g) => g.hooks.map((h) => h.command)),
    ...Object.values(cursor).flat().map((h) => h.command),
  ];
  for (const c of commands) {
    assert.match(c, /ai-collab-hook/);
    const script = c.match(/scripts\/(ai-collab-hook(?:\.mjs)?)/)[1];
    assert.ok(fs.existsSync(path.join(ROOT, "scripts", script)), script);
    assert.match(c, /--host (claude|codex|cursor)$/);
  }
});

test("shell wrappers are executable", () => {
  for (const f of ["scripts/ai-collab", "scripts/ai-collab-hook"]) {
    fs.accessSync(path.join(ROOT, f), fs.constants.X_OK);
  }
});

test("package and plugin manifests carry one version", () => {
  const version = read("package.json").version;
  const lock = read("package-lock.json");
  assert.equal(lock.version, version, "package-lock.json");
  assert.equal(lock.packages[""].version, version, "package-lock.json packages['']");
  for (const m of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".cursor-plugin/plugin.json"]) assert.equal(read(m).version, version, m);
});
