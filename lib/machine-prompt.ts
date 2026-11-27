// Prompt text that did not come from the operator typing: wake runs, harness machinery, other agents, ai-collab.
// Pure, so the browser UI and the server share one definition.

// Prompt a wake run sends to a resumed session (lib/sessions/control.ts); it is not the operator typing.
export const WAKE_PROMPT = "Read the pending AI Collab operator messages for this exact session and reply to the operator in the same AI Collab conversation.";
// Set in the environment of harness runs started by wake, so their hooks never count as the operator.
export const WAKE_ENV = "AI_COLLAB_WAKE";
export const SYSTEM_PROMPT_ENV = "AI_COLLAB_SYSTEM_PROMPT";
// Prompt text that harness machinery (task notifications, subagent hand-backs), other agents, or ai-collab produced.
export const MACHINE_PREFIXES = ["<task-notification>", "[SYSTEM NOTIFICATION", "<agent-message", "<cross-session-message", "[ai-collab]", "Another Claude session sent a message"];

/** True when prompt text came from harness machinery, another agent, or ai-collab itself. */
export function machinePrompt(prompt: unknown): boolean {
  const text = typeof prompt === "string" ? prompt.trimStart() : "";
  return MACHINE_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/** True when a submitted prompt came from the operator: not a wake run, the wake prompt, or machine text. */
export function operatorPrompt(prompt: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const text = typeof prompt === "string" ? prompt.trim() : "";
  return env[WAKE_ENV] !== "1" && text !== "" && !machinePrompt(text) && text !== WAKE_PROMPT;
}
