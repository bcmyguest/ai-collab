// Input-schema fragments shared by the operation table; JSON Schema is the MCP wire format, so no zod here.
export type Surface = "cli" | "mcp" | "code" | "control";
export type JsonSchema = Record<string, unknown>;

export const WAIT = { type: "integer", minimum: 0, maximum: 45, default: 25 };
export const IDENTITY = { type: "string", pattern: "^[a-f0-9]{16}$", description: "Session label from the ai-collab hook context." };
export const MESSAGE_ID = { type: "string", pattern: "^[a-zA-Z0-9-]{1,64}$" };
export const BODY = { type: "string", minLength: 1, maxLength: 4000 };
export const URGENT = { type: "boolean", default: false, description: "Deliver at the recipient's very next hook event (its next tool call or stop), skipping the poll throttle. Nothing interrupts a model mid-generation." };
