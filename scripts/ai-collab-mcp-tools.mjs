#!/usr/bin/env node
// The tool worker scripts/ai-collab-mcp.mjs runs; it restarts this process when a deploy replaces the plugin copy.
import { toolClient } from "../lib/tool-api.ts";
import { READ_TOOLS, readsThroughRunCode } from "../lib/code-run.ts";
import { runCodeReadRecipe } from "../lib/store-read.ts";
import { serveToolWorker } from "../lib/surfaces/mcp-reload.ts";

const host = process.argv[2] || "";
// Tag launches and machine defaults can require reads through run_code.
const runCodeFirst = readsThroughRunCode();
const client = toolClient({ host });
// With reads through run_code, read tools stay listed (hidden, a probe fell back to the CLI) but say where to call them.
const redirect = (tool) => ({ ...tool, description: `Do not call directly: call run_code (ai-collab-code server) with ai.${tool.name}(...) and batch your other reads in the same program. ${tool.description}` });

serveToolWorker({
  listTools: () => client.listTools().map((tool) => (runCodeFirst && READ_TOOLS.includes(tool.name) ? redirect(tool) : tool)),
  callTool: async (name, args, signal) => {
    if (runCodeFirst && READ_TOOLS.includes(name)) return { isError: true, text: runCodeReadRecipe(name, args) };
    const result = await client.callTool(name, args, { signal });
    return { text: JSON.stringify(result) };
  },
});
