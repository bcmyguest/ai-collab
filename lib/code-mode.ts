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
import { autoDefaults } from "./config.ts";
import { CODEX_CODE_MODE_KEY, codexCodeModeArgs, codexRequiredRunCodeArgs, REQUIRE_RUN_CODE_ENV } from "./harness.ts";

export { CODEX_CODE_MODE_KEY, codexCodeModeArgs, codexRequiredRunCodeArgs, REQUIRE_RUN_CODE_ENV };
export const CODE_MODE_DEFAULT = true;
// Harnesses with a native code mode; Cursor and OpenCode have none (they get the run_code MCP tool only).
export const CODE_MODE_HARNESSES = ["claude", "codex"];
export const CLAUDE_CODE_MODE_ENV = "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE";

/** A code-mode value as a boolean: true/false, "on"/"off", "true"/"false", "1"/"0"; undefined for anything else. */
export function parseCodeMode(value: unknown): boolean | undefined {
  if (value === true || value === false) return value;
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["on", "true", "1", "yes"].includes(text)) return true;
  if (["off", "false", "0", "no"].includes(text)) return false;
  return undefined;
}

/** The global setting: defaults.json "codeMode" when it parses, else CODE_MODE_DEFAULT. */
export function codeModeDefault(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseCodeMode(autoDefaults(env)?.codeMode) ?? CODE_MODE_DEFAULT;
}

/** The setting for one start: its own value when given, else the global one. */
export function resolveCodeMode(value: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return parseCodeMode(value) ?? codeModeDefault(env);
}

/** Claude flag settings that turn code mode on or off; the only layer a headless run reads it from. */
export function claudeCodeModeSettings(on: boolean) {
  return { env: { [CLAUDE_CODE_MODE_ENV]: on ? "1" : "0" } };
}

/** The `config` override a Codex app-server thread/start or thread/resume takes. */
export function codexThreadConfig(on: unknown) {
  return { [CODEX_CODE_MODE_KEY]: on === true };
}
