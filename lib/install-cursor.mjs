/** Install this plugin tree for Cursor local plugins (same pattern as smarter-compact). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packPluginCopy } from "./plugin-copy.ts";

export const PLUGIN_NAME = "ai-collab";


// Our entries in ~/.cursor/hooks.json are recognised by this path fragment, so reinstalling replaces them.
const OWN_HOOK = /\/plugins\/local\/ai-collab\/scripts\/ai-collab-hook/;

// The package files only (lib/plugin-copy.ts); hooks/ is dropped because Cursor would also run the Claude hooks in it.
function cleanCopy(src, dest) {
  packPluginCopy(src, dest);
  fs.rmSync(path.join(dest, "hooks"), { recursive: true, force: true });
}

export function cursorPluginDest(home = os.homedir()) {
  return path.join(home, ".cursor", "plugins", "local", PLUGIN_NAME);
}

/** Walk up from the caller's file to the directory holding this package.json. */
export function packageRoot(importMetaUrl) {
  let dir = path.dirname(fileURLToPath(importMetaUrl));
  for (;;) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        if (JSON.parse(fs.readFileSync(pkg, "utf8")).name === PLUGIN_NAME) return dir;
      } catch { /* keep walking */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * @param {{ home?: string, importMetaUrl: string, copy?: boolean }} opts
 * @returns {{ ok: boolean, dest: string, mode: "symlink"|"copy", message?: string }}
 */
export function installCursorPlugin({ home = os.homedir(), importMetaUrl, copy = false } = {}) {
  const src = packageRoot(importMetaUrl);
  if (!src) return { ok: false, dest: "", mode: "copy", message: "package root not found" };
  if (!fs.existsSync(path.join(src, ".cursor-plugin", "plugin.json"))) {
    return { ok: false, dest: "", mode: "copy", message: `missing Cursor plugin manifest under ${src}` };
  }
  const dest = cursorPluginDest(home);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.rmSync(dest, { recursive: true, force: true });
  } catch { /* missing */ }
  const mode = copy ? "copy" : "symlink";
  try {
    if (copy) cleanCopy(src, dest);
    else fs.symlinkSync(src, dest, "dir");
  } catch (err) {
    if (!copy && err.code === "EPERM") {
      cleanCopy(src, dest);
      return { ok: true, dest, mode: "copy", message: "symlink failed; copied instead" };
    }
    return { ok: false, dest, mode, message: err.message };
  }
  const hooks = installCursorHooks({ home, src, dest });
  const warning = copy ? "" : "symlinked: Cursor also runs the Claude hooks in hooks/hooks.json; use --copy";
  const message = [hooks.ok ? "" : hooks.message, warning].filter(Boolean).join("; ");
  return { ok: true, dest, mode, ...(message ? { message } : {}) };
}

/**
 * Cursor's CLI runs only some plugin hooks (sessionStart, stop) but every hook in ~/.cursor/hooks.json, so ours go
 * there: hooks/cursor-hooks.json with the plugin root resolved, replacing earlier ai-collab entries, keeping all others.
 */
export function installCursorHooks({ home = os.homedir(), src, dest = cursorPluginDest(home) }) {
  const file = path.join(home, ".cursor", "hooks.json");
  try {
    const ours = JSON.parse(fs.readFileSync(path.join(src, "hooks", "cursor-hooks.json"), "utf8")).hooks;
    let current = { version: 1, hooks: {} };
    if (fs.existsSync(file)) current = JSON.parse(fs.readFileSync(file, "utf8"));
    const merged = {};
    for (const [event, list] of Object.entries(current.hooks || {})) {
      const kept = (Array.isArray(list) ? list : []).filter((h) => !OWN_HOOK.test(h?.command || ""));
      if (kept.length) merged[event] = kept;
    }
    for (const [event, list] of Object.entries(ours)) {
      const resolved = list.map((h) => ({ ...h, command: h.command.replaceAll("${CURSOR_PLUGIN_ROOT}", dest) }));
      merged[event] = [...(merged[event] || []), ...resolved];
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.ai-collab-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ ...current, version: current.version ?? 1, hooks: merged }, null, 2) + "\n");
    fs.renameSync(tmp, file);
    return { ok: true, file };
  } catch (err) {
    return { ok: false, file, message: `could not update ${file}: ${err.message}` };
  }
}
