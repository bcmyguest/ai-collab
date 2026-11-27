// Sandbox policy, harness argv and hook settings: what a builder sandbox may reach and run.
import * as S from "../sandbox.ts";
import { readFileSync } from "node:fs";
import { argv } from "../harness.ts";
import type { Harness } from "../harness.ts";
import { TRACE_ENV } from "../cursor-trace.ts";
import { SANDBOX, TOOLS } from "../sandbox.ts";

export const APP_IN = "/sandbox/tools/ai-collab";

export const CLAUDE_SETTINGS_IN = "/sandbox/home/.claude/builder-settings.json";

export const CLAUDE_MCP_IN = "/sandbox/home/.claude/builder-mcp.json";

export const CURSOR_DIR = "/sandbox/agent";

export const CODEX_DIR = "/sandbox/codex";

export const OPENCODE_DIR = "/sandbox/opencode";

export const CLAUDE_DIR = "/sandbox/claude";

export const CODE_MCP = "scripts/ai-collab-code-mcp.mjs";

// API hosts per harness; Cursor's and Claude's api host were measured on 2026-11-22, Codex's are UNVERIFIED; Claude's OAuth hosts come from the network-config docs.
const API_HOSTS = {
  opencode: ["opencode.ai", "models.dev"],
  cursor: ["api2.cursor.sh", "api3.cursor.sh", "api4.cursor.sh", "agentn.global.api5.cursor.sh", "cursor.com"],
  codex: ["chatgpt.com", "api.openai.com", "auth.openai.com", "ab.chatgpt.com"],
  claude: ["api.anthropic.com", "platform.claude.com", "claude.ai"],
};

// Harnesses whose API traffic skips OpenShell's TLS termination and L7 inspection.
const TLS_PASSTHROUGH = ["cursor", "opencode"];

export const NTFY_HOST = "host.openshell.internal";

export const NTFY_PORT = 8794;

// Host hook events that feed `oncebitten capture` when the host config names none.
const CAPTURE_EVENTS = { cursor: ["beforeSubmitPrompt", "postToolUse", "postToolUseFailure"], codex: ["UserPromptSubmit"], claude: ["UserPromptSubmit", "PostToolUse", "PostToolUseFailure"] };

// A lean headless Claude builder: the built-in tools a builder edits and tests with; Glob and Grep must be named on Linux.
const CLAUDE_TOOLS = "Bash,Read,Edit,Write,Glob,Grep";

// Documented in code.claude.com/docs/en/env-vars: each turns off a feature or network call a headless builder never needs.
export const CLAUDE_ENV = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1",
  DISABLE_FEEDBACK_COMMAND: "1", DISABLE_COST_WARNINGS: "1", CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1", CLAUDE_CODE_DISABLE_AGENT_VIEW: "1",
  CLAUDE_CODE_DISABLE_ARTIFACT: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
  CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
};

// The CLI marks itself non-dumpable unless this is set; OpenShell then cannot read its /proc/<pid>/exe and denies its DNS and sockets (measured 2026-11-22).
// The host traces a Cursor builder from its stream-json (lib/cursor-trace.mjs), so its in-sandbox hooks record nothing.
export const CURSOR_ENV = { CURSOR_AGENT_ALLOW_PROCESS_INSPECTION: "1", [TRACE_ENV]: "launcher" };

// ai-collab MCP tools that would act on sandbox-local state (task store, sessions, runs); the task shim replaces the task ones.
const CLAUDE_MCP_DENY = ["task_list", "task_update", "team_start", "team_status", "pattern_start", "pattern_advance", "pattern_status", "pattern_list", "interrupt", "list_sessions"]
  .map((tool) => `mcp__ai-collab__${tool}`);

// Tools a builder never uses, denied by bare name so they leave the context even if --tools changes.
const CLAUDE_TOOL_DENY = ["Agent", "Task", "WebFetch", "WebSearch", "Skill", "RemoteTrigger", "Artifact", "ArtifactData", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "PushNotification", "SendUserFile", "SendMessage", "Monitor", "Workflow", "DesignSync", "NotebookEdit", "EnterWorktree", "ExitWorktree"];

// Settings keys a headless builder turns off; the names are the ones the host's own settings.json uses.
const CLAUDE_SETTINGS = {
  autoCompactEnabled: true, autoCompactWindow: 250000,
  includeGitInstructions: false, autoMemoryEnabled: false, disableBundledSkills: true, disableWorkflows: true, disableArtifact: true,
  disableRemoteControl: true, remoteControlAtStartup: false, promptSuggestionEnabled: false, awaySummaryEnabled: false,
  agentPushNotifEnabled: false, inputNeededNotifEnabled: false, feedbackSurveyRate: 0, spinnerTipsEnabled: false,
  enabledPlugins: { "cc-plugin-telemetry@builtin": false, "cc-plugin-privacy@builtin": false, "cc-plugin-agents-md@builtin": false, "cc-plugin-plugin-authoring@builtin": false },
};

/** Harness argv in the sandbox, its own sandbox off; Codex gets hook trust (docs/builders.md). */
export function harnessCommand({ harness, model, brief, workdir, launcher, builderCode }: { harness: string; model: string; brief: string; workdir: string; launcher?: string; builderCode?: boolean }) {
  const sandbox = { tools: TOOLS, claudeTools: CLAUDE_TOOLS, mcpIn: CLAUDE_MCP_IN, settingsIn: CLAUDE_SETTINGS_IN };
  const command = argv(harness as Harness, "builder", { model, brief, workdir, launcher, builderCode, sandbox });
  if (!command) throw new Error(`unknown harness ${harness}`);
  return [command[0], ...command[1]];
}

/** The sandbox policy (JSON is YAML): the harness's API hosts and the host's ntfy port, for the named binaries only. */
export function builderPolicy({ harness, binaries, ntfyBinaries = [] }: { harness: string; binaries: string[]; ntfyBinaries?: string[] }) {
  // Cursor and OpenCode keep their own TLS: through the TLS-terminating proxy Zen refuses free models (measured 2026-11-22).
  const apiEndpoint = (host: string) => TLS_PASSTHROUGH.includes(harness)
    ? { host, port: 443, protocol: "tcp", tls: "skip" }
    : endpoint(host, 443);
  const endpoint = (host: string, port: number) => ({ host, port, protocol: "rest", access: "full" });
  return {
    version: 1,
    filesystem_policy: {
      include_workdir: true,
      read_only: ["/usr", "/lib", "/bin", "/proc", "/dev/urandom", "/etc", "/var/log"],
      read_write: [SANDBOX, "/tmp", "/dev/null"],
    },
    landlock: { compatibility: "best_effort" },
    network_policies: {
      [harness]: { name: harness, endpoints: API_HOSTS[harness as keyof typeof API_HOSTS].map(apiEndpoint), binaries: binaries.map((path) => ({ path })) },
      ai_collab: { name: "ai-collab", endpoints: [endpoint(NTFY_HOST, NTFY_PORT)], binaries: [...binaries, ...ntfyBinaries].map((path) => ({ path })) },
    },
  };
}

/** The lean Claude settings file: feature switches, denied tools, and the capture hooks. */
export function claudeSettings(events: string[]) {
  return { ...CLAUDE_SETTINGS, permissions: { deny: [...CLAUDE_TOOL_DENY, ...CLAUDE_MCP_DENY] }, ...captureHooks("claude", events) };
}

/** The only MCP servers a Claude builder gets: ai-collab, and code mode when its script exists; none without node. */
export function claudeMcpConfig({ node, project, codeMode }: { node: string; project: string; codeMode: boolean }) {
  if (!node) return { mcpServers: {} };
  const server = (script: string) => ({ command: `${TOOLS}/node/bin/node`, args: [`${APP_IN}/${script}`], env: { AI_COLLAB_PROJECT: project, AI_COLLAB_PEER: "claude" } });
  return { mcpServers: { "ai-collab": server("scripts/ai-collab-mcp.mjs"), ...(codeMode ? { "ai-collab-code": server(CODE_MCP) } : {}) } };
}

/** Hook settings that save every capture payload in the sandbox: Cursor's hooks.json, Codex's, or Claude's settings hooks. */
export function captureHooks(harness: string, events: string[]) {
  const command = `${TOOLS}/bin/ob-capture ${harness}`;
  if (harness === "cursor") return { version: 1, hooks: Object.fromEntries(events.map((e) => [e, [{ command }]])) };
  return { hooks: Object.fromEntries(events.map((e) => [e, [{ hooks: [{ type: "command", command }] }]])) };
}

/** Hook events whose host commands run `oncebitten capture`, read from the host's hooks.json; defaults when none. */
export function hostCaptureEvents(harness: string, file: string) {
  let hooks: Record<string, unknown> = {};
  try { hooks = JSON.parse(readFileSync(file, "utf8")).hooks ?? {}; } catch { return CAPTURE_EVENTS[harness as keyof typeof CAPTURE_EVENTS]; }
  const captures = (entry: unknown): boolean => {
    const e = entry as { command?: unknown; hooks?: unknown[] } | undefined;
    return /oncebitten\S*'?\s+capture/.test(String(e?.command ?? "")) || (e?.hooks ?? []).some(captures);
  };
  const events = Object.entries(hooks).filter(([, list]) => Array.isArray(list) && list.some(captures)).map(([event]) => event);
  return events.length ? events : CAPTURE_EVENTS[harness as keyof typeof CAPTURE_EVENTS];
}
