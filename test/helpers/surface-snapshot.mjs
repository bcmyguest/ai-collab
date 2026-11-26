import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** Starts an MCP server over stdio, sends initialize and tools/list, and returns both results. */
export async function snapshotMcp(script, { args = [], env = {} } = {}) {
  const child = spawn(process.execPath, [script, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const request = async (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return JSON.parse((await lines.next()).value);
  };
  try {
    const initialize = await request(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "golden", version: "0" } });
    const list = await request(2, "tools/list", {});
    return { initialize: initialize.result, tools: list.result.tools };
  } finally {
    child.stdin.end();
    child.kill();
  }
}
