// Serves a tool list over MCP stdio; tool definitions pass through unchanged, so agents see the same names and schemas.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod-v3";

// Clients may send initialize without capabilities or clientInfo; the SDK schema would reject that.
const INITIALIZE = z.object({
  method: z.literal("initialize"),
  params: z.object({ protocolVersion: z.string().optional() }).passthrough().optional(),
}).passthrough();
const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
const LATEST_PROTOCOL_VERSION = "2025-11-25";

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface McpSurface {
  name: string;
  version: string;
  instructions: string;
  listTools: () => unknown[];
  callTool: (name: string, args: Record<string, any>, signal: AbortSignal) => Promise<ToolResult>;
}

/** Connects an MCP server to stdio. A thrown tool error becomes an isError result, not a JSON-RPC error. */
export async function serveMcp(surface: McpSurface): Promise<void> {
  const server = new Server(
    { name: surface.name, version: surface.version },
    { capabilities: { tools: {} }, instructions: surface.instructions },
  );
  server.setRequestHandler(INITIALIZE as any, async (request: any) => {
    const requested = request.params?.protocolVersion;
    return {
      protocolVersion: PROTOCOL_VERSIONS.has(requested) ? requested : LATEST_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: surface.name, version: surface.version },
      instructions: surface.instructions,
    };
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: surface.listTools() as any[] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const { text, isError } = await surface.callTool(request.params.name, request.params.arguments ?? {}, extra.signal);
      return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: (error as Error).message }] };
    }
  });
  await server.connect(new StdioServerTransport());
}
