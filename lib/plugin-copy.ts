/** A clean plugin copy: only package.json's "files" list, never node_modules, git data, worktrees or build output. */
import fs from "node:fs";
import path from "node:path";

// Claude, Codex and Cursor copy their plugin folder; a checkout with worktrees once made a 42 GB plugin cache.
export const PLUGIN_COPY_MAX_BYTES = 50 * 1024 * 1024;
const PLUGIN_ALWAYS = ["package.json", "README.md", "LICENSE"];
const NEVER = /(^|\/)(node_modules|\.git|\.next[^/]*)(\/|$)/;
// Harnesses that run the plugin from a copy under ~/.local/share/ai-collab (lib/setup.ts installPlugin).
export const COPIED_PLUGINS = ["claude", "codex"];

/**
 * Copies only package.json's "files" list (plus the manifest, README and LICENSE) from root into dest, replacing dest.
 * Entries are paths or "dir/*.ext" globs, as npm pack reads them. Throws, leaving dest untouched, past PLUGIN_COPY_MAX_BYTES.
 */
export function packPluginCopy(root: string, dest: string) {
  const files: string[] = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).files ?? [];
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  let bytes = 0;
  const copy = (rel: string): void => {
    const from = path.join(root, rel);
    if (!fs.existsSync(from)) return;
    fs.cpSync(from, path.join(tmp, rel), { recursive: true, filter: (src) => !NEVER.test(path.relative(root, src)) });
  };
  try {
    for (const entry of [...PLUGIN_ALWAYS, ...files]) {
      if (!entry.includes("*")) { copy(entry); continue; }
      const dir = path.dirname(entry);
      const re = new RegExp(`^${path.basename(entry).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
      for (const name of fs.existsSync(path.join(root, dir)) ? fs.readdirSync(path.join(root, dir)) : []) {
        if (re.test(name) && fs.statSync(path.join(root, dir, name)).isFile()) copy(path.join(dir, name));
      }
    }
    const walk = (dir: string): void => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else bytes += fs.statSync(p).size; } };
    walk(tmp);
    if (bytes > PLUGIN_COPY_MAX_BYTES) throw new Error(`plugin copy is ${Math.round(bytes / 1048576)} MB, over the ${PLUGIN_COPY_MAX_BYTES / 1048576} MB limit; check package.json "files"`);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
  return { dest, bytes };
}

/** Re-copies root into each installed <peer>-plugin folder under home, so running harnesses load the deployed code. Returns the peers refreshed. */
export function refreshPluginCopies(root: string, home: string): string[] {
  const refreshed: string[] = [];
  for (const peer of COPIED_PLUGINS) {
    const dest = path.join(home, ".local", "share", "ai-collab", `${peer}-plugin`);
    if (!fs.existsSync(dest)) continue;
    packPluginCopy(root, dest);
    refreshed.push(peer);
  }
  return refreshed;
}
