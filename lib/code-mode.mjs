/**
 * Native code mode for sessions ai-collab starts: the model writes one program that calls many tools, and only its
 * result returns. Default ON; defaults.json "codeMode" sets it globally, a start or a team.dot role overrides it.
 *
 * Verified on 2026-11-22 against the installed CLIs (docs/code-mode.md):
 *   - Claude Code 2.1.330 reads CLAUDE_CODE_EXPERIMENTAL_CODE_MODE, but a headless run (claude -p, the Agent SDK)
 *     takes it only from the flag-settings layer (--settings / the SDK's `settings` option), not from the shell env.
 *     Background jobs (claude --bg) refuse it and start with the ordinary tools.
 *   - Codex 0.171.0 has the feature flag `features.code_mode` ("under development"); `-c features.code_mode=true`
 *     and the app-server's thread/start `config` both accept it.
 */
import { fileURLToPath } from "node:url";
import { autoDefaults } from "./config.mjs";

export const CODE_MODE_DEFAULT = true;
export const REQUIRE_RUN_CODE_ENV = "AI_COLLAB_REQUIRE_RUN_CODE";
// Harnesses with a native code mode; Cursor and OpenCode have none (they get the run_code MCP tool only).
export const CODE_MODE_HARNESSES = ["claude", "codex"];
export const CLAUDE_CODE_MODE_ENV = "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE";
export const CODEX_CODE_MODE_KEY = "features.code_mode";

/** A code-mode value as a boolean: true/false, "on"/"off", "true"/"false", "1"/"0"; undefined for anything else. */
export function parseCodeMode(value) {
  if (value === true || value === false) return value;
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["on", "true", "1", "yes"].includes(text)) return true;
  if (["off", "false", "0", "no"].includes(text)) return false;
  return undefined;
}

/** The global setting: defaults.json "codeMode" when it parses, else CODE_MODE_DEFAULT. */
export function codeModeDefault(env = process.env) {
  return parseCodeMode(autoDefaults(env)?.codeMode) ?? CODE_MODE_DEFAULT;
}

/** The setting for one start: its own value when given, else the global one. */
export function resolveCodeMode(value, env = process.env) {
  return parseCodeMode(value) ?? codeModeDefault(env);
}

/** Claude flag settings that turn code mode on or off; the only layer a headless run reads it from. */
export function claudeCodeModeSettings(on) {
  return { env: { [CLAUDE_CODE_MODE_ENV]: on ? "1" : "0" } };
}

/** `-c` arguments for a Codex CLI child. */
export function codexCodeModeArgs(on) {
  return ["-c", `${CODEX_CODE_MODE_KEY}=${on ? "true" : "false"}`];
}

/** Register the local MCP scripts for tagged Codex starts, with the session folder as their cwd. */
export function codexRequiredRunCodeArgs() {
  const script = (name) => JSON.stringify(fileURLToPath(new URL(`../scripts/${name}-mcp.mjs`, import.meta.url)));
  return [
    "-c", `mcp_servers.ai-collab={command="node",args=[${script("ai-collab")},"codex"],env_vars=["${REQUIRE_RUN_CODE_ENV}"]}`,
    "-c", `mcp_servers.ai-collab-code={command="node",args=[${script("ai-collab-code")},"codex"],tool_timeout_sec=150}`,
  ];
}

/** The `config` override a Codex app-server thread/start or thread/resume takes. */
export function codexThreadConfig(on) {
  return { [CODEX_CODE_MODE_KEY]: on === true };
}
