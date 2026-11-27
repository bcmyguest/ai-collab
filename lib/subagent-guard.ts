/**
 * Native subagents and shell harness starts are off in sessions ai-collab starts (team and pattern members, builders,
 * spawned agents). The flags, env and hook denials per harness; docs/spawn-agent-spec.md Part A.
 */
import { basename } from "node:path";
import { MANAGED_ENV, SHELL_START_DENIED } from "./agent-guard.mjs";
import { loadConfig } from "./config.mjs";
import { harnessOfBinary, type Harness } from "./harness.ts";
import { readOwned } from "./sessions/registry.ts";
import { commandSegments, hookReadCall } from "./store-read.mjs";

export { MANAGED_ENV, SHELL_START_DENIED };
// Claude Code built-in subagent tool; "Task" is its legacy alias (SDK 0.3.330 BUILTIN_TOOL_NAMES).
export const CLAUDE_SUBAGENT_TOOLS = ["Agent", "Task"] as const;
// Claude CLI settings that deny the subagent tool; `--settings` takes one value, `--disallowedTools` is variadic.
export const CLAUDE_NO_SUBAGENT_SETTINGS = JSON.stringify({ permissions: { deny: ["Agent", "Task"] } });
// Codex 0.171.0: [agents].enabled=false removes spawn_agent, wait_agent and the other collaboration tools.
export const CODEX_NO_SUBAGENTS = { "agents.enabled": false, "features.multi_agent_v2": false } as const;
export const CODEX_NO_SUBAGENT_ARGS = ["-c", "agents.enabled=false", "-c", "features.multi_agent_v2=false"] as const;
// OpenCode 2.2.6 permission rule; the action name comes from GET /api/agent.
export const OPENCODE_NO_SUBAGENTS = [{ action: "subagent", resource: "*", effect: "deny" }] as const;
export const OPENCODE_NO_SUBAGENT_CONFIG = JSON.stringify({ permission: { subagent: "deny" } });
export const SUBAGENT_DENIED = "Native subagents are off in sessions ai-collab starts. Use the ai-collab spawn_agent tool "
  + "(or `ai-collab spawn`); the child reports back to you by message.";
// Programs that run the next word as the command.
const WRAPPERS = new Set(["env", "nohup", "exec", "command", "time", "setsid", "nice"]);
// A harness run with only these arguments starts no session.
const INFO_ARGS = new Set(["--version", "-v", "--help", "-h"]);

type Env = NodeJS.ProcessEnv;
type HookMsg = Record<string, unknown>;

/** Whether env marks this process as part of a session ai-collab started. */
export function managedEnv(env: Env): boolean {
  return env[MANAGED_ENV] === "1";
}

/** The CLI args that turn native subagents off for a detached start of this harness; [] for opencode and cursor. */
export function noSubagentArgs(harness: Harness): string[] {
  if (harness === "claude") return ["--settings", CLAUDE_NO_SUBAGENT_SETTINGS];
  if (harness === "codex") return [...CODEX_NO_SUBAGENT_ARGS];
  return [];
}

/** The extra env for a detached managed start: MANAGED_ENV=1, plus OPENCODE_CONFIG_CONTENT for opencode. */
export function noSubagentEnv(harness: Harness, env: Env): Env {
  const out: Env = { [MANAGED_ENV]: "1" };
  if (harness !== "opencode") return out;
  const current = env.OPENCODE_CONFIG_CONTENT;
  let config: Record<string, unknown> = {};
  if (current) {
    try { config = JSON.parse(current); } catch { throw new Error("OPENCODE_CONFIG_CONTENT is not valid JSON"); }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("OPENCODE_CONFIG_CONTENT is not a JSON object");
  }
  const permission = config.permission && typeof config.permission === "object" && !Array.isArray(config.permission) ? config.permission : {};
  out.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...config, permission: { ...permission, subagent: "deny" } });
  return out;
}

/** Whether a hook call starts a native subagent: Claude PreToolUse Agent/Task, Cursor subagentStart, OpenCode task. */
export function nativeSubagentCall(host: string, key: string, msg: HookMsg): boolean {
  const tool = typeof msg.tool_name === "string" ? msg.tool_name : "";
  if (host === "claude") return key === "pretooluse" && (CLAUDE_SUBAGENT_TOOLS as readonly string[]).includes(tool);
  if (host === "cursor") return key === "subagentstart";
  if (host === "opencode") return key === "pretooluse" && tool.toLowerCase() === "task";
  return false;
}

// The harness a shell segment runs, past env assignments and wrappers like nohup; "" for any other program.
function segmentHarness(segment: string): string {
  const words = segment.split(/\s+/).map((w) => w.replace(/^["']|["']$/g, "")).filter(Boolean);
  while (words.length && (WRAPPERS.has(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || (words[0].startsWith("-") && words.length > 1))) words.shift();
  if (words[0] === "timeout" && words.length > 2) words.splice(0, 2);
  const harness = words.length ? harnessOfBinary(basename(words[0])) : undefined;
  if (!harness) return "";
  return words.length > 1 && words.slice(1).every((w) => INFO_ARGS.has(w)) ? "" : harness;
}

/** Whether a hook call runs a shell command that starts a harness: Claude or OpenCode Bash, Cursor beforeShellExecution. */
export function shellHarnessStart(host: string, key: string, msg: HookMsg): boolean {
  const shell = (host === "cursor" && key === "beforeshellexecution")
    || ((host === "claude" || host === "opencode") && key === "pretooluse" && String(msg.tool_name ?? "").toLowerCase() === "bash");
  if (!shell) return false;
  const call = hookReadCall(key, msg) as { input?: { command?: unknown } } | null;
  const command = typeof call?.input?.command === "string" ? call.input.command : "";
  return commandSegments(command).some((segment: string) => segmentHarness(segment) !== "");
}

/** The deny output for that host, in the shape storeReadDenial uses (lib/store-read.mjs). */
export function subagentDenial(host: string, reason: string = SUBAGENT_DENIED) {
  if (host === "cursor") return { permission: "deny", user_message: reason, agent_message: reason };
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

/** Whether the session's owned record marks it managed and live; Cursor's shared ACP process carries no per-session env. */
export function managedOwned(env: Env, { cwd, host, session }: { cwd: string; host: string; session: string }): boolean {
  const cfg = loadConfig(env, { cwd, host, session });
  if (!cfg.enabled || !("stateDir" in cfg)) return false;
  const record = readOwned(cfg, session) as { managed?: unknown; status?: unknown } | null;
  return record?.managed === true && record.status !== "ended";
}

/** The hook denial for a managed session's subagent or shell harness start, or null for anything else. */
export function managedDenial(host: string, key: string, msg: HookMsg, env: Env, where: { cwd: string; host: string; session: string }): ReturnType<typeof subagentDenial> | null {
  const reason = nativeSubagentCall(host, key, msg) ? SUBAGENT_DENIED : shellHarnessStart(host, key, msg) ? SHELL_START_DENIED : "";
  if (!reason) return null;
  return managedEnv(env) || managedOwned(env, where) ? subagentDenial(host, reason) : null;
}
