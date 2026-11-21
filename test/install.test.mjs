import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installCursorPlugin, cursorPluginDest } from "../lib/install-cursor.mjs";

test("cursor install copies the plugin into a (temporary) home's local plugin dir", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-home-"));
  const r = installCursorPlugin({ home, importMetaUrl: import.meta.url, copy: true });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.dest, cursorPluginDest(home));
  assert.ok(fs.existsSync(path.join(r.dest, ".cursor-plugin", "plugin.json")));
  for (const skipped of ["hooks", ".git", ".claude"]) assert.equal(fs.existsSync(path.join(r.dest, skipped)), false, `${skipped} is not copied`);
  assert.ok(fs.existsSync(path.join(r.dest, "scripts", "ai-collab-hook")));
  fs.rmSync(home, { recursive: true, force: true });
});

test("cursor install symlinks by default and replaces an existing install", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-home-"));
  const first = installCursorPlugin({ home, importMetaUrl: import.meta.url });
  assert.equal(first.ok, true, first.message);
  const second = installCursorPlugin({ home, importMetaUrl: import.meta.url });
  assert.equal(second.ok, true, second.message);
  assert.ok(fs.lstatSync(second.dest).isSymbolicLink() || second.mode === "copy");
  fs.rmSync(home, { recursive: true, force: true });
});

test("cursor install writes our hooks into ~/.cursor/hooks.json, keeps other tools' hooks, and stays idempotent", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-home-"));
  const file = path.join(home, ".cursor", "hooks.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, hooks: { postToolUse: [{ command: "other-tool capture" }], preToolUse: [{ command: "rtk hook cursor" }] } }));
  installCursorPlugin({ home, importMetaUrl: import.meta.url, copy: true });
  installCursorPlugin({ home, importMetaUrl: import.meta.url, copy: true });
  const { hooks } = JSON.parse(fs.readFileSync(file, "utf8"));
  const ours = (event) => hooks[event].filter((h) => h.command.includes("ai-collab-hook"));
  assert.deepEqual(hooks.preToolUse, [{ command: "rtk hook cursor" }]);
  assert.equal(hooks.postToolUse[0].command, "other-tool capture");
  for (const event of ["sessionStart", "beforeSubmitPrompt", "afterAgentResponse", "postToolUse", "stop"]) {
    assert.equal(ours(event).length, 1, `${event} once after two installs`);
    assert.equal(ours(event)[0].command.startsWith(`"${cursorPluginDest(home)}/scripts/ai-collab-hook"`), true, ours(event)[0].command);
  }
  assert.equal(ours("stop")[0].timeout, 660);
  fs.rmSync(home, { recursive: true, force: true });
});
