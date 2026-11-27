// Installs the OpenCode 2 plugin (a shim in the global plugins folder), the ai-collab and ai-collab-code MCP servers, and the skills path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { packageRoot } from "./install-cursor.ts";

/** opencode.json as parsed; only the mcp and skills keys are read. */
// oxlint-disable-next-line typescript/no-explicit-any -- user-edited JSON; merges read nested keys
type OpenCodeConfig = Record<string, any>;
type McpEntry = { type: string; command: string[]; cwd: string; enabled: boolean };

export interface OpenCodeInstall {
  ok: boolean;
  plugin: string;
  config: string;
  message?: string;
}

export const OPENCODE_PLUGIN_FILE = "ai-collab.js";
export const MCP_NAME = "ai-collab";
export const CODE_MCP_NAME = "ai-collab-code";
// First line of the shim; a plugins/ai-collab.js without it belongs to someone else and is left alone.
const SHIM_MARK = "// ai-collab-managed";

/** OpenCode's global config folder: $XDG_CONFIG_HOME/opencode, else ~/.config/opencode. */
export function opencodeConfigDir({ home = os.homedir(), env = {} }: { home?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode");
}

/** The shim OpenCode loads from plugins/: it re-exports lib/opencode-plugin.mjs from this checkout. */
export function pluginShim(src: string): string {
  const url = pathToFileURL(path.join(src, "lib", "opencode-plugin.mjs")).href;
  return `${SHIM_MARK}: written by scripts/install-opencode.mjs; rerun it to update.\nexport { default } from ${JSON.stringify(url)};\n`;
}

/** A local MCP server entry (default: the ai-collab server); cwd "." resolves to the session's workspace, where projects.json matching starts. */
export function mcpEntry(src: string, script = "ai-collab-mcp.mjs"): McpEntry {
  return { type: "local", command: ["node", path.join(src, "scripts", script), "opencode"], cwd: ".", enabled: true };
}

// Writes through a temporary file and a rename, so OpenCode never reads a half-written file.
function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.ai-collab-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Config with our MCP entry: under mcp.servers (what `opencode mcp add` writes), or flat when the file already lists servers flat. */
export function mergeMcp(config: OpenCodeConfig, entry: unknown, name: string = MCP_NAME) {
  const out = { ...config };
  const mcp: OpenCodeConfig = out.mcp && typeof out.mcp === "object" && !Array.isArray(out.mcp) ? { ...out.mcp } : {};
  const flat = !mcp.servers && Object.values(mcp).some((v) => v && typeof v === "object" && ("command" in v || "url" in v));
  if (flat) mcp[name] = entry;
  else mcp.servers = { ...(mcp.servers && typeof mcp.servers === "object" ? mcp.servers : {}), [name]: entry };
  out.mcp = mcp;
  return out;
}

/** Config with a skills path added once; OpenCode's "skills" key lists extra folders to discover skills from. */
export function mergeSkills(config: OpenCodeConfig, dir: string) {
  const add = (list: unknown[]): unknown[] => [...list.filter((s) => s !== dir), dir];
  // The object form ({paths, urls}) keeps its other keys; the path goes into paths.
  if (config.skills && typeof config.skills === "object" && !Array.isArray(config.skills)) {
    const paths = Array.isArray(config.skills.paths) ? config.skills.paths : [];
    return { ...config, skills: { ...config.skills, paths: add(paths) } };
  }
  return { ...config, skills: add(Array.isArray(config.skills) ? config.skills : []) };
}

/** Writes plugins/ai-collab.js and opencode.json's mcp and skills entries, keeping other settings; refuses a foreign shim or bad JSON. */
export function installOpenCode({ home = os.homedir(), env = {}, importMetaUrl, src = importMetaUrl ? packageRoot(importMetaUrl) : null }: { home?: string; env?: NodeJS.ProcessEnv; importMetaUrl?: string | URL; src?: string | null } = {}): OpenCodeInstall {
  if (!src) return { ok: false, plugin: "", config: "", message: "package root not found" };
  const dir = opencodeConfigDir({ home, env });
  const plugin = path.join(dir, "plugins", OPENCODE_PLUGIN_FILE);
  const config = path.join(dir, "opencode.json");
  if (fs.existsSync(plugin) && !fs.readFileSync(plugin, "utf8").startsWith(SHIM_MARK)) {
    return { ok: false, plugin, config, message: `${plugin} exists and was not written by ai-collab` };
  }
  let current: OpenCodeConfig = {};
  if (fs.existsSync(config)) {
    try {
      current = JSON.parse(fs.readFileSync(config, "utf8"));
    } catch (err) {
      return { ok: false, plugin, config, message: `could not parse ${config}: ${(err as Error).message}` };
    }
  } else if (fs.existsSync(path.join(dir, "opencode.jsonc"))) {
    return { ok: false, plugin, config, message: `${path.join(dir, "opencode.jsonc")} has comments; add the mcp entry by hand (README, OpenCode)` };
  }
  try {
    writeAtomic(plugin, pluginShim(src));
    // Both servers: ai-collab, and ai-collab-code (run_code, docs/code-mode.md).
    const servers = mergeMcp(mergeMcp(current, mcpEntry(src)), mcpEntry(src, "ai-collab-code-mcp.mjs"), CODE_MCP_NAME);
    writeAtomic(config, JSON.stringify(mergeSkills(servers, path.join(src, "skills")), null, 2) + "\n");
  } catch (err) {
    return { ok: false, plugin, config, message: (err as Error).message };
  }
  return { ok: true, plugin, config };
}
