/**
 * Agent file reads of the task store and state dir. The same paths `classifyCall` counts as bypass_read
 * (builder state excluded). A human shell never reaches this: only a harness hook calls it.
 */
const STORE = /(?:\.local\/share\/ai-collab\/tasks|\.local\/state\/ai-collab)(?!\/builders)/;
const READER = /^(?:cat|head|tail|less|more|grep|rg|jq|sed|awk|ls|find|wc|stat|tac|nl|python3?|node)\b/;
const FILE_READ_TOOLS = new Set(["read", "grep", "glob", "list", "view", "readfile", "read_file"]);

const text = (value) => typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
const str = (value) => Array.isArray(value) ? value.join(" ") : text(value);

/** Shell segments split on && || ; | and newlines, minus leading env assignments. */
export function commandSegments(command) {
  return command.split(/&&|\|\||[;|\n]/).map((s) => s.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "")).filter(Boolean);
}

/**
 * True when this tool call is a file or shell read of the task store or state dir, builder state excluded.
 * Same match as analyze-sources classifyCall path "bypass_read".
 */
export function isStoreBypass({ name = "", input } = {}) {
  const command = typeof input === "string" ? input : str(input?.command ?? input?.cmd);
  if (command) return commandSegments(command).some((segment) => READER.test(segment) && STORE.test(segment));
  return FILE_READ_TOOLS.has(String(name).toLowerCase()) && STORE.test(text(input));
}

/** The MCP read-tool refusal, one string for the MCP server and the file-read hook. */
export function runCodeReadRecipe(name, args = {}) {
  return `Call ${name} through run_code (ai-collab-code server), batching the other reads you need in one program: `
    + `{ "code": "return await ai.${name}(${JSON.stringify(args)});", "session": "<your session label>" }. Direct reads are disabled for this session.`;
}

/** task_list for the task store; list_sessions for the state dir. */
export function storeReadRecipe(input) {
  const blob = typeof input === "string" ? input : text(input);
  return runCodeReadRecipe(/\.local\/share\/ai-collab\/tasks/.test(blob) ? "task_list" : "list_sessions", {});
}

/** A hook payload as the tool call isStoreBypass understands, or null when this event is not a read. */
export function hookReadCall(key, msg) {
  if (key === "beforereadfile") {
    const file = msg.file_path || msg.path;
    return { name: "Read", input: { file_path: typeof file === "string" ? file : "" } };
  }
  if (key === "beforeshellexecution") return { name: "Bash", input: { command: typeof msg.command === "string" ? msg.command : "" } };
  if (key === "pretooluse") return { name: typeof msg.tool_name === "string" ? msg.tool_name : "", input: msg.tool_input };
  return null;
}

/** Harness denial carrying the run_code recipe, or null when this event is not a store read. */
export function storeReadDenial(host, key, msg) {
  const call = hookReadCall(key, msg);
  if (!call || !isStoreBypass(call)) return null;
  const recipe = storeReadRecipe(call.input);
  if (host === "cursor") return { permission: "deny", user_message: recipe, agent_message: recipe };
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: recipe,
    },
  };
}
