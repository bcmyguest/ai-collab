/**
 * Harness names, their binaries, the `harness:model` text form, the fallback model and every per-harness command line.
 * A leaf module: start, controls, builder, team authoring, delivery, interrupt and the Cursor runner take them from here.
 */
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { modeFlags } from "../web/lib/start-mode.js";

export const HARNESSES = ["claude", "codex", "cursor", "opencode"] as const;
export type Harness = (typeof HARNESSES)[number];
export type HarnessModel = { harness: Harness; model: string };
export type Command = [file: string, args: string[]];
export type BuilderSandbox = { tools: string; claudeTools: string; mcpIn: string; settingsIn: string };

// The Cursor model every built-in default and fallback uses.
export const FALLBACK_MODEL = "deepseek-v41-flash-1017-high";
// Shape of a model name a start may pass; membership in lib/models.mjs's allowlist is checked by the caller.
export const MODEL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:[\]-]{0,79}$/;
// OpenCode names a model provider/model#variant (`opencode run --help`); the model part may hold more slashes.
export const OPENCODE_MODEL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}\/[a-zA-Z0-9][a-zA-Z0-9._:@/[\]-]{0,119}(#[a-zA-Z0-9._-]{1,40})?$/;
// Cursor renamed its CLI to `agent`; `cursor-agent` is kept as the fallback for installs that predate it.
export const CURSOR_BINARIES: readonly string[] = ["agent", "cursor-agent"];
// The executable each harness starts as on a host; the Cursor name on a given PATH is cursorBinary's.
export const LAUNCH_BINARY: Readonly<Record<Harness, string>> = { claude: "claude", codex: "codex", cursor: "cursor-agent", opencode: "opencode" };
// Lets `codex exec` run plugin hooks without persisted trust, which only the interactive `/hooks` review writes.
export const CODEX_HOOK_TRUST = "--dangerously-bypass-hook-trust";
// Claude Code's --permission-mode values (`claude --help`; the Agent SDK's PermissionMode). "manual" is an alias of "default".
export const CLAUDE_PERMISSION_MODES: readonly string[] = ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"];
// The defaults.json claudePermissionMode that is "default" while AFK is on and passes nothing otherwise.
export const CLAUDE_PERMISSION_AUTO = "auto-afk";
// The defaults.json claudePermissionMode that passes nothing, so the user's own Claude settings apply.
export const CLAUDE_PERMISSION_INHERIT = "inherit";
// Every value a Claude permission setting may name: defaults.json, a team.dot attribute, or a start option.
export const CLAUDE_PERMISSION_VALUES: readonly string[] = [CLAUDE_PERMISSION_AUTO, CLAUDE_PERMISSION_INHERIT, ...CLAUDE_PERMISSION_MODES];
export const REQUIRE_RUN_CODE_ENV = "AI_COLLAB_REQUIRE_RUN_CODE";
export const CODEX_CODE_MODE_KEY = "features.code_mode";
// The harness each agent binary runs as, by the binary's name. A Map, so a name like "constructor" finds nothing.
const BINARY_HARNESS = new Map<string, Harness>([
  ["agent", "cursor"],
  ["cursor-agent", "cursor"],
  ["claude", "claude"],
  ["codex", "codex"],
  ["opencode", "opencode"],
]);

export type ArgvOpts = {
  start: { root: string; prompt: string; worktree?: string; model?: string; mode?: string; permission?: string; codeMode?: boolean; requireRunCode?: boolean; noSubagents?: string[] };
  wake: { id: string; prompt: string; requireRunCode?: boolean; path?: string; permission?: string };
  compact: { id: string };
  queue: { id: string; text: string };
  interrupt: Record<string, never>;
  builder: { model: string; brief: string; workdir: string; launcher?: string; builderCode?: boolean; sandbox: BuilderSandbox };
  author: { prompt: string; model?: string };
  acp: { force?: boolean; model?: string };
};
export type ArgvKind = keyof ArgvOpts;

/** Whether a name is one of the four harnesses. */
export function isHarness(name: unknown): name is Harness {
  return typeof name === "string" && (HARNESSES as readonly string[]).includes(name);
}

/** The harness an agent binary runs as, by its name; undefined for any other program. */
export function harnessOfBinary(name: string): Harness | undefined {
  return BINARY_HARNESS.get(name);
}

/** Whether a model name has the shape this harness's start may pass. */
export function modelShape(harness: string, model: unknown): boolean {
  return typeof model === "string" && (harness === "opencode" ? OPENCODE_MODEL_NAME : MODEL_NAME).test(model);
}

/** Parses "harness" or "harness:model"; the model must pass modelShape. Null for anything else, a bare harness gives model "". */
export function parseHarnessModel(text: unknown): HarnessModel | null {
  if (typeof text !== "string") return null;
  const at = text.indexOf(":");
  const harness = at < 0 ? text : text.slice(0, at);
  const model = at < 0 ? "" : text.slice(at + 1);
  if (!isHarness(harness) || (at >= 0 && !modelShape(harness, model))) return null;
  return { harness, model };
}

/** "harness:model", or "harness" when the model is empty. */
export function formatHarnessModel({ harness, model }: HarnessModel): string {
  return model ? `${harness}:${model}` : harness;
}

/** `-c` arguments for a Codex CLI child. */
export function codexCodeModeArgs(on: boolean): string[] {
  return ["-c", `${CODEX_CODE_MODE_KEY}=${on ? "true" : "false"}`];
}

/** Register the local MCP scripts for tagged Codex starts, with the session folder as their cwd. */
export function codexRequiredRunCodeArgs(): string[] {
  const script = (name: string) => JSON.stringify(fileURLToPath(new URL(`../scripts/${name}-mcp.mjs`, import.meta.url)));
  return [
    "-c", `mcp_servers.ai-collab={command="node",args=[${script("ai-collab")},"codex"],env_vars=["${REQUIRE_RUN_CODE_ENV}"]}`,
    "-c", `mcp_servers.ai-collab-code={command="node",args=[${script("ai-collab-code")},"codex"],tool_timeout_sec=150}`,
  ];
}

/** The child's PATH: the caller's first, then node's directory and ~/.local/bin. */
export function childPath(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath): string {
  return [env.PATH, dirname(execPath), join(env.HOME || homedir(), ".local", "bin")].filter(Boolean).join(delimiter);
}

/** The Cursor CLI's binary name on this PATH: the first directory holding `agent` or the older `cursor-agent` decides. */
export function cursorBinary(path = ""): string {
  for (const dir of path.split(delimiter).filter((d) => isAbsolute(d))) {
    const found = CURSOR_BINARIES.find((name) => {
      try { accessSync(join(dir, name), constants.X_OK); return true; } catch { return false; }
    });
    if (found) return found;
  }
  return CURSOR_BINARIES[0];
}

/** The Cursor binary a start or wake runs: the name cursorBinary finds on `path`. */
export function cursorCommandFor({ path = "" }: { path?: string } = {}): string {
  return cursorBinary(path);
}

/** "" when the value is a Claude permission setting, else the message naming the valid ones. */
export function claudePermissionError(value: unknown): string {
  return CLAUDE_PERMISSION_VALUES.includes(value as string) ? "" : `claudePermissionMode must be one of ${CLAUDE_PERMISSION_VALUES.join(", ")}; got ${JSON.stringify(value)}`;
}

/** The --permission-mode a Claude start passes: the setting itself, "default" for auto-afk while AFK is on, else undefined. */
export function claudePermissionFlag(setting: string, afk: boolean): string | undefined {
  if (setting === CLAUDE_PERMISSION_INHERIT) return undefined;
  if (setting !== CLAUDE_PERMISSION_AUTO) return setting;
  return afk ? "default" : undefined;
}

// A start's argv: the mode flags, Codex code mode, the model after the mode flags, and a managed start's no-subagent args
// last before the prompt. Null for a model or mode it cannot pass.
function startArgv(harness: Harness, o: ArgvOpts["start"]): Command | null {
  if (o.model !== undefined && !modelShape(harness, o.model)) return null;
  const chosen = modeFlags(harness, o.mode ?? "agent");
  if (!chosen) return null;
  const flag = (name: string) => (o.model === undefined ? [] : [name, o.model]);
  const off = o.noSubagents ?? [];
  switch (harness) {
    // A plan mode's own --permission-mode wins over the configured permission mode.
    case "claude": return [LAUNCH_BINARY.claude, ["--bg", ...(o.worktree ? ["--worktree", o.worktree] : []), ...(chosen.length ? chosen : o.permission ? ["--permission-mode", o.permission] : []), ...flag("--model"), ...off, o.prompt]];
    // Codex code mode is a feature flag; Claude --bg refuses code mode (background job), so it gets nothing.
    case "codex": return [LAUNCH_BINARY.codex, ["exec", "--json", CODEX_HOOK_TRUST, ...(typeof o.codeMode === "boolean" ? codexCodeModeArgs(o.codeMode) : []), ...(o.requireRunCode ? codexRequiredRunCodeArgs() : []), ...chosen, ...flag("-m"), ...off, o.prompt]];
    case "cursor": return [LAUNCH_BINARY.cursor, ["-p", "--trust", "--output-format", "stream-json", "--workspace", o.root, ...chosen, ...flag("--model"), o.prompt]];
    // `opencode run` works in its cwd (the project root or a worktree); --format json prints one event per line.
    case "opencode": return [LAUNCH_BINARY.opencode, ["run", "--format", "json", ...chosen, ...flag("-m"), o.prompt]];
    default: return null;
  }
}

// A wake resumes a saved session with the wake prompt; Cursor's binary is the one cursorBinary finds on the wake's PATH.
function wakeArgv(harness: Harness, o: ArgvOpts["wake"]): Command | null {
  switch (harness) {
    // A stored /permission value is the session's next-wake mode; without one the wake passes no flag.
    case "claude": return [LAUNCH_BINARY.claude, ["--print", "--resume", o.id, ...(o.permission ? ["--permission-mode", o.permission] : []), o.prompt]];
    case "codex": return [LAUNCH_BINARY.codex, ["exec", ...(o.requireRunCode ? codexRequiredRunCodeArgs() : []), "resume", o.id, o.prompt]];
    case "cursor": return [cursorBinary(o.path ?? ""), ["--print", "--resume", o.id, o.prompt]];
    case "opencode": return [LAUNCH_BINARY.opencode, ["run", "--session", o.id, o.prompt]];
    default: return null;
  }
}

// OpenCode's server compacts a session through its API, running or not (operation session.compact).
function compactArgv(harness: Harness, o: ArgvOpts["compact"]): Command | null {
  if (harness !== "opencode") return null;
  return [LAUNCH_BINARY.opencode, ["api", "session.compact", "--param", `sessionID=${o.id}`, "--data", "{}"]];
}

// The one queued message `codex queue` takes for a thread; other harnesses deliver through their own API.
function queueArgv(harness: Harness, o: ArgvOpts["queue"]): Command | null {
  if (harness !== "codex") return null;
  return [LAUNCH_BINARY.codex, ["queue", "--thread", o.id, "--message", o.text, "--resume"]];
}

// The app-server proxy a Codex interrupt runs over; `codex queue` has no interrupt.
function interruptArgv(harness: Harness): Command | null {
  if (harness !== "codex") return null;
  return [LAUNCH_BINARY.codex, ["app-server", "proxy"]];
}

// Argv that runs the harness inside the sandbox; the outer sandbox is the isolation, so the harness's own is off.
// Variadic flags (--tools, --mcp-config) would swallow the prompt, so --settings comes last before it.
function builderArgv(harness: Harness, o: ArgvOpts["builder"]): Command | null {
  const s = o.sandbox;
  switch (harness) {
    case "cursor": return [LAUNCH_BINARY.cursor, ["-p", "--force", "--trust", "--sandbox", "disabled", "--model", o.model, ...(o.builderCode ? ["--approve-mcps", "--output-format", "stream-json"] : []), o.brief]];
    case "opencode": return [LAUNCH_BINARY.opencode, ["run", "--standalone", "--auto", "--format", "json", "--model", o.model, o.brief]];
    case "codex": return [LAUNCH_BINARY.codex, ["exec", "-m", o.model, "--dangerously-bypass-approvals-and-sandbox", CODEX_HOOK_TRUST, "--skip-git-repo-check", "-C", o.workdir, o.brief]];
    case "claude": return [
      o.launcher || `${s.tools}/bin/claude`, ["-p", "--model", o.model, "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose",
        "--tools", s.claudeTools, "--strict-mcp-config", "--mcp-config", s.mcpIn, "--disable-slash-commands", "--no-chrome",
        "--setting-sources", "", "--settings", s.settingsIn, o.brief],
    ];
    default: return null;
  }
}

// One non-interactive writing-agent turn; the prompt is one element, so no shell quoting applies.
function authorArgv(harness: Harness, o: ArgvOpts["author"]): Command | null {
  const model = o.model ?? "";
  const flag = model ? ["--model", model] : [];
  switch (harness) {
    case "cursor": return [LAUNCH_BINARY.cursor, ["-p", "--trust", ...flag, o.prompt]];
    case "claude": return [LAUNCH_BINARY.claude, ["-p", ...flag, o.prompt]];
    case "codex": return [LAUNCH_BINARY.codex, ["exec", ...(model ? ["-m", model] : []), o.prompt]];
    case "opencode": return [LAUNCH_BINARY.opencode, ["run", ...(model ? ["-m", model] : []), o.prompt]];
    default: return null;
  }
}

// The Cursor ACP server, the runner's own protocol: `acp`, then `--force` when the mode asks for it, then `--model` when one is named.
function acpArgv(harness: Harness, o: ArgvOpts["acp"]): Command | null {
  if (harness !== "cursor") return null;
  return [LAUNCH_BINARY.cursor, ["acp", ...(o.force ? ["--force"] : []), ...(o.model ? ["--model", o.model] : [])]];
}

/**
 * The argv one harness takes for one kind of run: [file, args], or null when that harness has no such run or the
 * options name a model or mode it cannot pass. The one owner of per-harness command lines.
 */
export function argv<K extends ArgvKind>(harness: Harness, kind: K, opts: ArgvOpts[K]): Command | null {
  switch (kind) {
    case "start": return startArgv(harness, opts as ArgvOpts["start"]);
    case "wake": return wakeArgv(harness, opts as ArgvOpts["wake"]);
    case "compact": return compactArgv(harness, opts as ArgvOpts["compact"]);
    case "queue": return queueArgv(harness, opts as ArgvOpts["queue"]);
    case "interrupt": return interruptArgv(harness);
    case "builder": return builderArgv(harness, opts as ArgvOpts["builder"]);
    case "author": return authorArgv(harness, opts as ArgvOpts["author"]);
    case "acp": return acpArgv(harness, opts as ArgvOpts["acp"]);
    default: return null;
  }
}
