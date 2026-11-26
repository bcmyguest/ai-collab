// Serves a tool list over MCP stdio with the official SDK; tool definitions pass through unchanged.
// The plugin runs without node_modules, so the SDK comes from a checked-in bundle (tools/vendor-mcp-sdk.mjs).
import { CallToolRequestSchema, ListToolsRequestSchema, Server, StdioServerTransport } from "../vendor/mcp-sdk.mjs";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Args } from "./types.ts";

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface McpSurface {
  name: string;
  version: string;
  instructions: string;
  listTools: () => unknown[];
  callTool: (name: string, args: Args, signal: AbortSignal) => Promise<ToolResult>;
}

/** Reads requests from stdin and answers on stdout. A thrown tool error becomes an isError result. */
export function serveMcp(surface: McpSurface): void {
  const server = new Server(
    { name: surface.name, version: surface.version },
    { capabilities: { tools: {} }, instructions: surface.instructions },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: surface.listTools() as Tool[] }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
    try {
      const { text, isError } = await surface.callTool(params.name, params.arguments ?? {}, signal);
      return { ...(isError ? { isError: true } : {}), content: [{ type: "text" as const, text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: (error as Error).message }] };
    }
  });
  const transport = new StdioServerTransport();
  // The SDK transport ignores end of input; closing it aborts every call still running, as the client has gone.
  process.stdin.once("end", () => { void server.close(); });
  void server.connect(transport);
}
