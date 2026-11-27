// The ai-collab-code MCP server (run_code) is registered for all four harnesses beside the ai-collab server.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_MCP_NAME, installOpenCode, mcpEntry, mergeMcp } from "../lib/install-opencode.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => JSON.parse(readFileSync(path.join(ROOT, p), "utf8"));

test("Claude, Codex and Cursor manifests start scripts/ai-collab-code-mcp.mjs with their own host name", () => {
  for (const [file, host, root] of [[".mcp.json", "claude", "${CLAUDE_PLUGIN_ROOT}"], [".codex-plugin/plugin.json", "codex", "${PLUGIN_ROOT}"], [".cursor-plugin/plugin.json", "cursor", "${CURSOR_PLUGIN_ROOT}"]]) {
    const servers = read(file).mcpServers;
    assert.ok(servers["ai-collab"], `${file} keeps the ai-collab server`);
    assert.deepEqual(servers["ai-collab-code"].args, [`${root}/scripts/ai-collab-code-mcp.mjs`, host], file);
    assert.equal(servers["ai-collab-code"].command, "node");
  }
  // Codex's default MCP tool timeout is shorter than run_code's longest program.
  assert.ok(read(".codex-plugin/plugin.json").mcpServers["ai-collab-code"].tool_timeout_sec >= 130);
  assert.ok(existsSync(path.join(ROOT, "scripts", "ai-collab-code-mcp.mjs")));
});

test("the OpenCode installer writes both servers and mergeMcp takes a server name", (t) => {
  assert.deepEqual(mergeMcp({}, { type: "local" }, "x").mcp, { servers: { x: { type: "local" } } });
  assert.deepEqual(mcpEntry("/src", "ai-collab-code-mcp.mjs").command, ["node", "/src/scripts/ai-collab-code-mcp.mjs", "opencode"]);
  const home = tempDir(t, "ai-collab-code-opencode-");
  try {
    const result = installOpenCode({ home, importMetaUrl: import.meta.url });
    assert.equal(result.ok, true, result.message);
    const config = JSON.parse(readFileSync(result.config, "utf8"));
    assert.deepEqual(Object.keys(config.mcp.servers).sort(), ["ai-collab", CODE_MCP_NAME]);
    assert.deepEqual(config.mcp.servers[CODE_MCP_NAME].command, ["node", path.join(ROOT.replace(/\/$/, ""), "scripts", "ai-collab-code-mcp.mjs"), "opencode"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
