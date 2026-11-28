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
  listTools: () => unknown[] | Promise<unknown[]>;
  callTool: (name: string, args: Args, signal: AbortSignal) => Promise<ToolResult>;
  // The tool list can change while the session runs; toolsChanged() tells the client to fetch it again.
  listChanged?: boolean;
}

export interface McpServing {
  toolsChanged: () => void;
  // Settles when the client closes stdin.
  closed: Promise<void>;
}

/** Reads requests from stdin and answers on stdout. A thrown tool error becomes an isError result. */
export function serveMcp(surface: McpSurface): McpServing {
  const server = new Server(
    { name: surface.name, version: surface.version },
    { capabilities: { tools: surface.listChanged ? { listChanged: true } : {} }, instructions: surface.instructions },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (await surface.listTools()) as Tool[] }));
  // End of input aborts the calls still running, then waits for their answers: a piped request still gets one.
  const gone = new AbortController();
  const running = new Set<Promise<unknown>>();
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
    try {
      const call = surface.callTool(params.name, params.arguments ?? {}, AbortSignal.any([signal, gone.signal]));
      running.add(call);
      void call.finally(() => running.delete(call)).catch(() => {});
      const { text, isError } = await call;
      return { ...(isError ? { isError: true } : {}), content: [{ type: "text" as const, text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: (error as Error).message }] };
    }
  });
  const transport = new StdioServerTransport();
  // The SDK transport ignores end of input, so the server closes itself once the answers are written.
  const closed = new Promise<void>((resolve) => process.stdin.once("end", async () => {
    gone.abort();
    await Promise.allSettled([...running]);
    await new Promise((settle) => setImmediate(settle));
    await server.close().finally(resolve);
  }));
  void server.connect(transport);
  return { toolsChanged: () => { void server.sendToolListChanged().catch(() => {}); }, closed };
}
