// A serveMcp surface with fixed tools, for the stdio protocol characterisation.
import { serveMcp } from "../../lib/surfaces/render-mcp.ts";

const TOOLS = [
  { name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "slow", description: "Waits until cancelled", inputSchema: { type: "object", properties: {} } },
];

serveMcp({
  name: "fake",
  version: "9.9.9",
  instructions: "Fake instructions.",
  listTools: () => TOOLS,
  callTool: async (name, args, signal) => {
    if (name === "echo") return { text: JSON.stringify(args) };
    if (name === "refuse") return { isError: true, text: "refused" };
    if (name === "boom") throw new Error("boom failed");
    if (name === "slow") {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      process.stderr.write("slow aborted\n");
      return { text: "late" };
    }
    throw new Error(`unknown tool ${name}`);
  },
});
