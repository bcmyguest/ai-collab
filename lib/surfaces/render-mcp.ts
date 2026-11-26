// Serves a tool list over MCP stdio (newline-delimited JSON-RPC); tool definitions pass through unchanged.
import { createInterface } from "node:readline";
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

interface Request {
  id?: string | number | null;
  method?: string;
  params?: { requestId?: string | number; protocolVersion?: string; name?: string; arguments?: Args };
}

const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
const LATEST_PROTOCOL_VERSION = "2025-11-25";

/** Reads requests from stdin and answers on stdout. A thrown tool error becomes an isError result. */
export function serveMcp(surface: McpSurface): void {
  const active = new Map<unknown, AbortController>();

  const send = (message: Record<string, unknown>) => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };

  async function handle(request: Request | null) {
    const { id, method, params } = request ?? {};
    if (method === "notifications/cancelled") {
      active.get(params?.requestId)?.abort();
      return;
    }
    if (id === undefined) return;
    if (method === "initialize") {
      const requested = params?.protocolVersion;
      send({ id, result: {
        protocolVersion: requested !== undefined && PROTOCOL_VERSIONS.has(requested) ? requested : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: surface.name, version: surface.version },
        instructions: surface.instructions,
      } });
    } else if (method === "ping") {
      send({ id, result: {} });
    } else if (method === "tools/list") {
      send({ id, result: { tools: surface.listTools() } });
    } else if (method === "tools/call") {
      const controller = new AbortController();
      active.set(id, controller);
      try {
        const { text, isError } = await surface.callTool(params?.name ?? "", params?.arguments ?? {}, controller.signal);
        if (!controller.signal.aborted) send({ id, result: { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }] } });
      } catch (error) {
        if (!controller.signal.aborted) send({ id, result: { isError: true, content: [{ type: "text", text: (error as Error).message }] } });
      } finally {
        active.delete(id);
      }
    } else {
      send({ id, error: { code: -32601, message: "Method not found" } });
    }
  }

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    let message: Request;
    try { message = JSON.parse(line) as Request; }
    catch { send({ id: null, error: { code: -32700, message: "Parse error" } }); return; }
    void handle(message);
  });
  input.on("close", () => {
    for (const controller of active.values()) controller.abort();
  });
}
