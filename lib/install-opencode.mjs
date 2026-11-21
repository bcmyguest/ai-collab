// Installs the OpenCode 2 plugin (a shim in the global plugins folder) and the ai-collab MCP server entry.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { packageRoot } from "./install-cursor.mjs";

export const OPENCODE_PLUGIN_FILE = "ai-collab.js";
export const MCP_NAME = "ai-collab";
// First line of the shim; a plugins/ai-collab.js without it belongs to someone else and is left alone.
const SHIM_MARK = "// ai-collab-managed";

/** OpenCode's global config folder: $XDG_CONFIG_HOME/opencode, else ~/.config/opencode. */
export function opencodeConfigDir({ home = os.homedir(), env = {} } = {}) {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode");
}

/** The shim OpenCode loads from plugins/: it re-exports lib/opencode-plugin.mjs from this checkout. */
export function pluginShim(src) {
  const url = pathToFileURL(path.join(src, "lib", "opencode-plugin.mjs")).href;
  return `${SHIM_MARK}: written by scripts/install-opencode.mjs; rerun it to update.\nexport { default } from ${JSON.stringify(url)};\n`;
}

/** The local MCP server entry; cwd "." resolves to the session's workspace, where projects.json matching starts. */
export function mcpEntry(src) {
  return { type: "local", command: ["node", path.join(src, "scripts", "ai-collab-mcp.mjs"), "opencode"], cwd: ".", enabled: true };
}

// Writes through a temporary file and a rename, so OpenCode never reads a half-written file.
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.ai-collab-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Config with our MCP entry: under mcp.servers (what `opencode mcp add` writes), or flat when the file already lists servers flat. */
export function mergeMcp(config, entry) {
  const out = { ...config };
  const mcp = out.mcp && typeof out.mcp === "object" && !Array.isArray(out.mcp) ? { ...out.mcp } : {};
  const flat = !mcp.servers && Object.values(mcp).some((v) => v && typeof v === "object" && ("command" in v || "url" in v));
  if (flat) mcp[MCP_NAME] = entry;
  else mcp.servers = { ...(mcp.servers && typeof mcp.servers === "object" ? mcp.servers : {}), [MCP_NAME]: entry };
  out.mcp = mcp;
  return out;
}

/** Writes plugins/ai-collab.js and opencode.json's mcp entry, keeping other settings; refuses a foreign shim or bad JSON. */
export function installOpenCode({ home = os.homedir(), env = {}, importMetaUrl, src = importMetaUrl ? packageRoot(importMetaUrl) : null } = {}) {
  if (!src) return { ok: false, plugin: "", config: "", message: "package root not found" };
  const dir = opencodeConfigDir({ home, env });
  const plugin = path.join(dir, "plugins", OPENCODE_PLUGIN_FILE);
  const config = path.join(dir, "opencode.json");
  if (fs.existsSync(plugin) && !fs.readFileSync(plugin, "utf8").startsWith(SHIM_MARK)) {
    return { ok: false, plugin, config, message: `${plugin} exists and was not written by ai-collab` };
  }
  let current = {};
  if (fs.existsSync(config)) {
    try {
      current = JSON.parse(fs.readFileSync(config, "utf8"));
    } catch (err) {
      return { ok: false, plugin, config, message: `could not parse ${config}: ${err.message}` };
    }
  } else if (fs.existsSync(path.join(dir, "opencode.jsonc"))) {
    return { ok: false, plugin, config, message: `${path.join(dir, "opencode.jsonc")} has comments; add the mcp entry by hand (README, OpenCode)` };
  }
  try {
    writeAtomic(plugin, pluginShim(src));
    writeAtomic(config, JSON.stringify(mergeMcp(current, mcpEntry(src)), null, 2) + "\n");
  } catch (err) {
    return { ok: false, plugin, config, message: err.message };
  }
  return { ok: true, plugin, config };
}
