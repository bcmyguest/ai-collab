#!/usr/bin/env node
// Installs the OpenCode 2 plugin shim and the ai-collab MCP server into OpenCode's global config.
import { installOpenCode } from "../lib/install-opencode.mjs";

const result = installOpenCode({ importMetaUrl: import.meta.url, env: process.env });
if (!result.ok) {
  console.error(`ai-collab: ${result.message}`);
  process.exit(1);
}
console.log(`plugin -> ${result.plugin}`);
console.log(`mcp    -> ${result.config}`);
