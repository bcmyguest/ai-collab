/** Install this plugin tree for Cursor local plugins (same pattern as smarter-compact). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packPluginCopy } from "./plugin-copy.ts";

export const PLUGIN_NAME = "ai-collab";

export interface CursorInstall {
  ok: boolean;
  dest: string;
  mode: "symlink" | "copy";
  message?: string;
}

export interface CursorHooksResult {
  ok: boolean;
  file: string;
  message?: string;
}

type HookEntry = { command?: string; [key: string]: unknown };


// Our entries in ~/.cursor/hooks.json are recognised by this path fragment, so reinstalling replaces them.
const OWN_HOOK = /\/plugins\/local\/ai-collab\/scripts\/ai-collab-hook/;

// The package files only (lib/plugin-copy.ts); hooks/ is dropped because Cursor would also run the Claude hooks in it.
function cleanCopy(src: string, dest: string): void {
  packPluginCopy(src, dest);
  fs.rmSync(path.join(dest, "hooks"), { recursive: true, force: true });
}

export function cursorPluginDest(home: string = os.homedir()): string {
  return path.join(home, ".cursor", "plugins", "local", PLUGIN_NAME);
}

/** Walk up from the caller's file to the directory holding this package.json. */
export function packageRoot(importMetaUrl: string | URL): string | null {
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

/** Links (or with copy, copies) this package into Cursor's local plugins folder, then installs its hooks. */
export function installCursorPlugin({ home = os.homedir(), importMetaUrl, copy = false }: { home?: string; importMetaUrl?: string | URL; copy?: boolean } = {}): CursorInstall {
  const src = packageRoot(importMetaUrl as string | URL);
  if (!src) return { ok: false, dest: "", mode: "copy", message: "package root not found" };
  if (!fs.existsSync(path.join(src, ".cursor-plugin", "plugin.json"))) {
    return { ok: false, dest: "", mode: "copy", message: `missing Cursor plugin manifest under ${src}` };
  }
  const dest = cursorPluginDest(home);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.rmSync(dest, { recursive: true, force: true });
  } catch { /* missing */ }
  const mode: CursorInstall["mode"] = copy ? "copy" : "symlink";
  try {
    if (copy) cleanCopy(src, dest);
    else fs.symlinkSync(src, dest, "dir");
  } catch (err) {
    if (!copy && (err as NodeJS.ErrnoException).code === "EPERM") {
      cleanCopy(src, dest);
      return { ok: true, dest, mode: "copy", message: "symlink failed; copied instead" };
    }
    return { ok: false, dest, mode, message: (err as Error).message };
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
export function installCursorHooks({ home = os.homedir(), src, dest = cursorPluginDest(home) }: { home?: string; src: string; dest?: string }): CursorHooksResult {
  const file = path.join(home, ".cursor", "hooks.json");
  try {
    const ours: Record<string, HookEntry[]> = JSON.parse(fs.readFileSync(path.join(src, "hooks", "cursor-hooks.json"), "utf8")).hooks;
    // oxlint-disable-next-line quality/no-known-value-widening -- replaced by the parsed hooks.json
    let current: { version?: unknown; hooks?: Record<string, unknown>; [key: string]: unknown } = { version: 1, hooks: {} };
    if (fs.existsSync(file)) current = JSON.parse(fs.readFileSync(file, "utf8"));
    const merged: Record<string, HookEntry[]> = {};
    for (const [event, list] of Object.entries(current.hooks || {})) {
      const kept = (Array.isArray(list) ? list : []).filter((h: HookEntry) => !OWN_HOOK.test(h?.command || ""));
      if (kept.length) merged[event] = kept;
    }
    for (const [event, list] of Object.entries(ours)) {
      const resolved = list.map((h) => ({ ...h, command: (h.command as string).replaceAll("${CURSOR_PLUGIN_ROOT}", dest) }));
      merged[event] = [...(merged[event] || []), ...resolved];
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.ai-collab-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ ...current, version: current.version ?? 1, hooks: merged }, null, 2) + "\n");
    fs.renameSync(tmp, file);
    return { ok: true, file };
  } catch (err) {
    return { ok: false, file, message: `could not update ${file}: ${(err as Error).message}` };
  }
}
