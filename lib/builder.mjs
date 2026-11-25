/** `ai-collab builder ...`: start, run, list and stop builder agents, each in its own OpenShell sandbox. See docs/builders.md. */
import { isProjectPaused, PROJECT_PAUSED } from "./project-pause.ts";
import { writeJson } from "./store.ts";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { autoDefaults, stateDir } from "./config.mjs";
import { cursorBinary, findExecutable, projectRoot, PROMPT_MAX_CHARS, modelShape } from "./start.mjs";
import { argv, FALLBACK_MODEL, parseHarnessModel } from "./harness.ts";
import { runnerRequest, runnerSocket } from "./runner-request.mjs";
import { RUN_ID } from "./pattern-runs.mjs";
import { limitFromRunError } from "./limits.mjs";
import { withLock } from "./state.mjs";
import { TRACE_ENV, traceStream } from "./cursor-trace.mjs";
import { clipProgress, openTasks, reviewPacket, STATUSES } from "./tasks.mjs";
import { BUILDER_DIR_CAP, builderLiveRefusal, cleanBuilders } from "./builder-clean.mjs";
import * as S from "./sandbox.ts";
import { HOME_IN, NTFY_TOKEN_IN, OUT, SANDBOX, TOOLS, WORK } from "./sandbox.ts";

const CLI_SCRIPT = fileURLToPath(new URL("../scripts/ai-collab.mjs", import.meta.url));
export const BUILDER_HARNESSES = Object.freeze(["cursor", "codex", "claude", "opencode"]);
const DEFAULT_MODEL = { cursor: FALLBACK_MODEL, codex: "gpt-6.2-sol", claude: "haiku", opencode: "opencode/deepseek-v4.1-flash-free" };
// The ai-collab checkout this CLI runs from supplies the builder MCP servers.
const APP_ROOT = dirname(dirname(CLI_SCRIPT));
const APP_PARTS = ["package.json", "scripts", "lib", "web/lib"];
const CODE_MCP = "scripts/ai-collab-code-mcp.mjs";
const UNIT_PREFIX = "builder-";
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BASE_REF = "main";
// openshell 0.1.9 refuses a sandbox name over 19 characters (measured 2026-11-22).
const SANDBOX_PREFIX_MAX = 8;
export const BUILDER_START_TIMEOUT_MS = 15 * 60_000;
const GIT_TIMEOUT_MS = 600_000;
const SYNC_TIMEOUT_MS = 900_000;
const UNKNOWN_LIMIT_MS = 5 * 3600_000;
const CURSOR_DIR = "/sandbox/agent";
const CODEX_DIR = "/sandbox/codex";
const OPENCODE_DIR = "/sandbox/opencode";
const CLAUDE_DIR = "/sandbox/claude";
const APP_IN = "/sandbox/tools/ai-collab";
const CLAUDE_SETTINGS_IN = "/sandbox/home/.claude/builder-settings.json";
const CLAUDE_MCP_IN = "/sandbox/home/.claude/builder-mcp.json";
const SANDBOX_PATH = `${TOOLS}/bin:${TOOLS}/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
// API hosts per harness; Cursor's and Claude's api host were measured on 2026-11-22, Codex's are UNVERIFIED; Claude's OAuth hosts come from the network-config docs.
const API_HOSTS = {
  opencode: ["opencode.ai", "models.dev"],
  cursor: ["api2.cursor.sh", "api3.cursor.sh", "api4.cursor.sh", "agentn.global.api5.cursor.sh", "cursor.com"],
  codex: ["chatgpt.com", "api.openai.com", "auth.openai.com", "ab.chatgpt.com"],
  claude: ["api.anthropic.com", "platform.claude.com", "claude.ai"],
};
// Harnesses whose API traffic skips OpenShell's TLS termination and L7 inspection.
const TLS_PASSTHROUGH = ["cursor", "opencode"];
// glibc libraries the sandbox image provides itself; host copies would not match its loader.
const GLIBC_LIB = /^(libc|libm|libdl|libpthread|librt|ld-linux[^.]*)\.so/;
const NTFY_HOST = "host.openshell.internal";
const NTFY_PORT = 8794;
// Host hook events that feed `oncebitten capture` when the host config names none.
const CAPTURE_EVENTS = { cursor: ["beforeSubmitPrompt", "postToolUse", "postToolUseFailure"], codex: ["UserPromptSubmit"], claude: ["UserPromptSubmit", "PostToolUse", "PostToolUseFailure"] };
// A lean headless Claude builder: the built-in tools a builder edits and tests with; Glob and Grep must be named on Linux.
const CLAUDE_TOOLS = "Bash,Read,Edit,Write,Glob,Grep";
// Documented in code.claude.com/docs/en/env-vars: each turns off a feature or network call a headless builder never needs.
const CLAUDE_ENV = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1",
  DISABLE_FEEDBACK_COMMAND: "1", DISABLE_COST_WARNINGS: "1", CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1", CLAUDE_CODE_DISABLE_AGENT_VIEW: "1",
  CLAUDE_CODE_DISABLE_ARTIFACT: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
  CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
};
// The CLI marks itself non-dumpable unless this is set; OpenShell then cannot read its /proc/<pid>/exe and denies its DNS and sockets (measured 2026-11-22).
// The host traces a Cursor builder from its stream-json (lib/cursor-trace.mjs), so its in-sandbox hooks record nothing.
const CURSOR_ENV = { CURSOR_AGENT_ALLOW_PROCESS_INSPECTION: "1", [TRACE_ENV]: "launcher" };
// ai-collab MCP tools that would act on sandbox-local state (task store, sessions, runs); the task shim replaces the task ones.
const CLAUDE_MCP_DENY = ["task_list", "task_update", "team_start", "team_status", "pattern_start", "pattern_advance", "pattern_status", "pattern_list", "interrupt", "list_sessions"]
  .map((tool) => `mcp__ai-collab__${tool}`);
// Tools a builder never uses, denied by bare name so they leave the context even if --tools changes.
const CLAUDE_TOOL_DENY = ["Agent", "Task", "WebFetch", "WebSearch", "Skill", "RemoteTrigger", "Artifact", "ArtifactData", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "PushNotification", "SendUserFile", "SendMessage", "Monitor", "Workflow", "DesignSync", "NotebookEdit", "EnterWorktree", "ExitWorktree"];
// Settings keys a headless builder turns off; the names are the ones the host's own settings.json uses.
const CLAUDE_SETTINGS = {
  includeGitInstructions: false, autoMemoryEnabled: false, disableBundledSkills: true, disableWorkflows: true, disableArtifact: true,
  disableRemoteControl: true, remoteControlAtStartup: false, promptSuggestionEnabled: false, awaySummaryEnabled: false,
  agentPushNotifEnabled: false, inputNeededNotifEnabled: false, feedbackSurveyRate: 0, spinnerTipsEnabled: false,
  enabledPlugins: { "cc-plugin-telemetry@builtin": false, "cc-plugin-privacy@builtin": false, "cc-plugin-agents-md@builtin": false, "cc-plugin-plugin-authoring@builtin": false },
};
const FINAL_PHASES = ["finished", "failed", "stopped"];
const LIVE_STATES = ["active", "activating", "deactivating", "reloading"];
const USAGE = {
  start: "usage: builder start --task <id> [--harness cursor|codex|claude|opencode] [--model M] --brief <file> [--branch B] [--run ID]",
  run: "usage: builder run <id>",
  list: "usage: builder list [--all]",
  stop: "usage: builder stop <id>",
  clean: "usage: builder clean",
};
const AI_COLLAB_SHIM = `#!/bin/sh
# Inside a builder sandbox: records task set and task progress for the host to apply after the run.
case "$1 $2" in
  "task set"|"task progress") ;;
  "task show") cat "\${AI_COLLAB_BUILDER_TASKS:-${TOOLS}/tasks}/$3.json" 2>/dev/null || { echo "ai-collab: no snapshot of task $3 in this sandbox" >&2; exit 1; }; exit 0 ;;
  *) echo "ai-collab: inside the builder sandbox only 'task set', 'task progress' and 'task show' work" >&2; exit 2 ;;
esac
d="\${AI_COLLAB_BUILDER_OUT:-${OUT}}/ai-collab"; mkdir -p "$d" || exit 1
printf '%s\\0' "$@" > "$d/$(date +%s%N)-$$"
echo "ai-collab: recorded; the host applies it when this builder exits"
`;
const CAPTURE_SHIM = `#!/bin/sh
# Saves one hook payload; the host replays it into \`oncebitten capture\` after the run.
d="\${AI_COLLAB_BUILDER_OUT:-${OUT}}/oncebitten"; mkdir -p "$d" || exit 0
cat > "$d/$(date +%s%N)-$$-\${1:-unknown}.json"
exit 0
`;

/** Unit, sandbox, worktree and state paths for one builder id. */
export function builderPaths(id, env = process.env) {
  const home = env.HOME || homedir();
  const dir = join(stateDir(env), "builders", id);
  return {
    unit: `${UNIT_PREFIX}${id}`,
    sandbox: builderSandbox(id),
    worktree: join(env.AI_COLLAB_BUILDER_WORKTREES || home, `ai-collab-wt-${id}`),
    dir, state: join(dir, "state.json"), brief: join(dir, "brief.md"), policy: join(dir, "policy.yaml"),
    stage: join(dir, "stage"), back: join(dir, "back"), out: join(dir, "out"),
  };
}

/** A builder's sandbox name: b-<first 8 of the id>-<6 hex of its hash>, at most 17 characters. */
export function builderSandbox(id) {
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 6);
  return `b-${id.slice(0, SANDBOX_PREFIX_MAX).replace(/-+$/, "")}-${hash}`;
}

/** The builder id for a task id: lowercase letters, digits and dashes, at most 63 characters. */
export function builderId(taskId) {
  return String(taskId).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
}

/** The stopped builder snapshot used by the task handoff. A task done or waiting for review is not handed off again. */
export function stoppedBuilder(project, task, env) {
  const id = builderId(task.id);
  if (!ID_RE.test(id) || task.status === "done" || task.status === "review") return null;
  const paths = builderPaths(id, env);
  let state;
  try { state = readState(paths); } catch { return null; }
  if (state.project !== project || state.task !== task.id || !FINAL_PHASES.includes(state.phase)
      || state.sandboxCreated || state.sandboxDeleted === false || !existsSync(join(state.worktree, ".git"))) return null;
  if (state.phase !== "finished" || state.commits > 0 && !state.landed) {
    if (existsSync(join(paths.back, basename(state.worktree)))) return null;
  }
  return state;
}

/** The sandbox notes appended to every builder brief. */
export function briefNotes({ task, branch, workdir }) {
  return [
    "",
    "## Builder sandbox",
    `You run inside an OpenShell sandbox. Your worktree is ${workdir} on branch ${branch}; ${BASE_REF} is the base.`,
    "git, node, npm and oncebitten are on PATH. Commit your work on this branch with git; the host copies your commits back after you exit.",
    `\`ai-collab task set|progress\` are recorded and applied on the host when you exit; \`ai-collab task show ${task}\` prints a snapshot. Nothing else of ai-collab works here.`,
    "Use TMPDIR=$(mktemp -d -p /tmp) for the test suite: /dev/shm is not writable here.",
    `Before marking the task done, run \`oncebitten check --base ${BASE_REF}\` and fix what fires.`,
    `Finish with \`ai-collab task set ${task} status=done\`, or status=blocked detail=<reason>.`,
    "",
  ].join("\n");
}

/**
 * Argv that runs the harness inside the sandbox; the outer sandbox is the isolation, so the harness's own is off.
 * Codex also gets CODEX_HOOK_TRUST: `codex exec` runs plugin hooks only when their trust is persisted in config.toml,
 * which only the interactive `/hooks` review writes, so a headless run in a fresh worktree would fire none.
 */
export function harnessCommand({ harness, model, brief, workdir, launcher, builderCode }) {
  const sandbox = { tools: TOOLS, claudeTools: CLAUDE_TOOLS, mcpIn: CLAUDE_MCP_IN, settingsIn: CLAUDE_SETTINGS_IN };
  const command = argv(harness, "builder", { model, brief, workdir, launcher, builderCode, sandbox });
  if (!command) throw new Error(`unknown harness ${harness}`);
  return [command[0], ...command[1]];
}

/** The sandbox policy (JSON is YAML): the harness's API hosts and the host's ntfy port, for the named binaries only. */
export function builderPolicy({ harness, binaries, ntfyBinaries = [] }) {
  // Cursor and OpenCode keep their own TLS: through the TLS-terminating proxy Zen refuses free models (measured 2026-11-22).
  const apiEndpoint = (host) => TLS_PASSTHROUGH.includes(harness)
    ? { host, port: 443, protocol: "tcp", tls: "skip" }
    : endpoint(host, 443);
  const endpoint = (host, port) => ({ host, port, protocol: "rest", access: "full" });
  return {
    version: 1,
    filesystem_policy: {
      include_workdir: true,
      read_only: ["/usr", "/lib", "/bin", "/proc", "/dev/urandom", "/etc", "/var/log"],
      read_write: [SANDBOX, "/tmp", "/dev/null"],
    },
    landlock: { compatibility: "best_effort" },
    network_policies: {
      [harness]: { name: harness, endpoints: API_HOSTS[harness].map(apiEndpoint), binaries: binaries.map((path) => ({ path })) },
      ai_collab: { name: "ai-collab", endpoints: [endpoint(NTFY_HOST, NTFY_PORT)], binaries: [...binaries, ...ntfyBinaries].map((path) => ({ path })) },
    },
  };
}

/** The lean Claude settings file: feature switches, denied tools, and the capture hooks. */
export function claudeSettings(events) {
  return { ...CLAUDE_SETTINGS, permissions: { deny: [...CLAUDE_TOOL_DENY, ...CLAUDE_MCP_DENY] }, ...captureHooks("claude", events) };
}

/** The only MCP servers a Claude builder gets: ai-collab, and code mode when its script exists; none without node. */
export function claudeMcpConfig({ node, project, codeMode }) {
  if (!node) return { mcpServers: {} };
  const server = (script) => ({ command: `${TOOLS}/node/bin/node`, args: [`${APP_IN}/${script}`], env: { AI_COLLAB_PROJECT: project, AI_COLLAB_PEER: "claude" } });
  return { mcpServers: { "ai-collab": server("scripts/ai-collab-mcp.mjs"), ...(codeMode ? { "ai-collab-code": server(CODE_MCP) } : {}) } };
}

/** Hook settings that save every capture payload in the sandbox: Cursor's hooks.json, Codex's, or Claude's settings hooks. */
export function captureHooks(harness, events) {
  const command = `${TOOLS}/bin/ob-capture ${harness}`;
  if (harness === "cursor") return { version: 1, hooks: Object.fromEntries(events.map((e) => [e, [{ command }]])) };
  return { hooks: Object.fromEntries(events.map((e) => [e, [{ hooks: [{ type: "command", command }] }]])) };
}

/** Hook events whose host commands run `oncebitten capture`, read from the host's hooks.json; defaults when none. */
export function hostCaptureEvents(harness, file) {
  let hooks = {};
  try { hooks = JSON.parse(readFileSync(file, "utf8")).hooks ?? {}; } catch { return CAPTURE_EVENTS[harness]; }
  const captures = (entry) => /oncebitten\S*'?\s+capture/.test(String(entry?.command ?? "")) || (entry?.hooks ?? []).some(captures);
  const events = Object.entries(hooks).filter(([, list]) => Array.isArray(list) && list.some(captures)).map(([event]) => event);
  return events.length ? events : CAPTURE_EVENTS[harness];
}

/** Splits a recorded shim call (NUL-terminated arguments) into argv. */
export function parseRecordedCall(text) {
  const parts = String(text).split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

/** Whether a recorded call may be replayed on the host: only `task set` and `task progress`. */
export function replayable(argv) {
  return argv[0] === "task" && (argv[1] === "set" || argv[1] === "progress") && argv.length >= 4;
}

export async function builder([sub, ...rest], { env, cfg, out, err }) {
  const fail = (key) => { err.write(`ai-collab: ${USAGE[key]}\n`); return 1; };
  try {
    if (sub === "start") {
      const flags = parseStart(rest);
      if (!flags?.task || !flags.brief || (flags.harness !== undefined && !BUILDER_HARNESSES.includes(flags.harness))) return fail("start");
      const result = await startBuilder(flags, { env, cfg, readBrief: () => readFileSync(flags.brief, "utf8") });
      out.write([result.session ?? result.unit, result.task, result.sandbox, result.worktree, result.branch].join("\t") + "\n");
      return 0;
    }
    if (sub === "run") return rest.length === 1 ? await runBuilder(rest[0], { env, cfg, out, err }) : fail("run");
    if (sub === "list") return await listBuilders(rest, { env, out, fail });
    if (sub === "stop") return rest.length === 1 ? await stopBuilder(rest[0], { env, out, err }) : fail("stop");
    if (sub === "clean") {
      if (rest.length !== 0) return fail("clean");
      for (const id of await cleanBuilders(env)) out.write(`${id}\n`);
      return 0;
    }
  } catch (error) {
    err.write(`ai-collab: builder ${sub}: ${error.message}\n`);
    return 1;
  }
  err.write(`ai-collab: ${Object.values(USAGE).join("\n  ")}\n`);
  return 1;
}

function parseStart(argv) {
  const spec = ["--task", "--harness", "--model", "--brief", "--branch", "--run"];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const at = argv[i].indexOf("=");
    const [key, value] = at > 0 ? [argv[i].slice(0, at), argv[i].slice(at + 1)] : [argv[i], argv[i + 1]];
    if (!spec.includes(key) || value === undefined) return null;
    flags[key.slice(2)] = value;
    if (at < 0) i += 1;
  }
  return flags;
}

export async function startBuilder(flags, { env, cfg, readBrief }) {
  const order = autoDefaults(env)?.builderOrder;
  const preferred = Array.isArray(order) ? order.find((name) => BUILDER_HARNESSES.includes(name)) : undefined;
  const harness = flags.harness ?? preferred ?? "codex";
  if (!BUILDER_HARNESSES.includes(harness)) throw new Error("Unknown builder harness");
  if (flags.run !== undefined && !RUN_ID.test(flags.run)) throw new Error("invalid run id");
  if (!cfg.project) throw new Error("AI_COLLAB_PROJECT is not set and no project matches this folder");
  if (isProjectPaused(cfg)) throw new Error(PROJECT_PAUSED);
  const task = openTasks(cfg.project, env).list().find((t) => t.id === flags.task);
  if (!task) throw new Error(`no task ${flags.task} in project ${cfg.project}`);
  const id = builderId(flags.task);
  if (!ID_RE.test(id)) throw new Error(`task id ${flags.task} gives no usable builder id`);
  const paths = builderPaths(id, env);
  const brief = (readBrief ? readBrief() : flags.brief).trim();
  if (!brief) throw new Error("Builder brief is empty");
  const branch = flags.branch || `builder/${id}`;
  const model = flags.model || DEFAULT_MODEL[harness];
  const limited = cursorLimitDetail(harness, model, env);
  if (limited) throw new Error(limited);
  const workdir = `${WORK}/${basename(paths.worktree)}`;
  const prompt = `${brief}\n${briefNotes({ task: task.id, branch, workdir })}`;
  if (!readBrief) {
    if (!modelShape(harness, model)) throw new Error("Invalid builder model");
    if (brief.startsWith("-") || brief.includes("\0")) throw new Error("Start the builder brief with a heading or sentence and omit NUL characters");
    if (harness === "codex" && prompt.trim().length > PROMPT_MAX_CHARS) {
      throw new Error(`Builder brief and sandbox notes must fit within ${PROMPT_MAX_CHARS} characters`);
    }
  }
  if (existsSync(paths.worktree)) throw new Error(`worktree ${paths.worktree} already exists`);
  if (LIVE_STATES.includes(await unitState(paths.unit, env))) throw new Error(`unit ${paths.unit} is already running`);
  const crowded = builderLiveRefusal(env);
  if (crowded) throw new Error(crowded);
  const capped = await S.sandboxCapRefusal({ openshell: env.AI_COLLAB_OPENSHELL_BIN || "openshell", env, name: paths.sandbox });
  if (capped) throw new Error(capped);
  // One free slot: this start adds a directory, and the count must still end at the cap.
  await cleanBuilders(env, { cap: BUILDER_DIR_CAP - 1 });
  const root = projectRoot(cfg.project, env);
  await git(root, ["worktree", "add", "--quiet", paths.worktree, "-b", branch, BASE_REF], env);
  const nodeModules = join(root, "node_modules");
  if (existsSync(nodeModules)) symlinkSync(nodeModules, join(paths.worktree, "node_modules"));
  const base = (await git(root, ["rev-parse", BASE_REF], env)).trim();
  rmSync(paths.dir, { recursive: true, force: true });
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.brief, prompt);
  return launchBuilder(paths, {
    ...(flags.run ? { run: flags.run } : {}), id, task: task.id, project: cfg.project, harness, model, branch, base, root,
    worktree: paths.worktree, unit: paths.unit, sandbox: paths.sandbox,
  }, { env });
}

async function launchBuilder(paths, state, { env }) {
  const socket = runnerSocket(env);
  const owned = state.harness === "codex" && await runnerRequest("GET", "/v1/health", undefined, { socket, timeoutMs: 1000 }).then(() => true, (error) => {
    if (["ENOENT", "ECONNREFUSED"].includes(error.code)) return false;
    throw error;
  });
  writeState(paths, { ...state, owned, phase: "starting", started: Date.now(), attempt: randomUUID() });
  try {
    return await dispatchBuilder(paths, state, { env, owned, socket });
  } catch (error) {
    if (readState(paths).phase === "starting" && (!owned || (error.status && error.status !== 504))) {
      updateState(paths, { phase: "failed", ended: Date.now(), error: error.message });
    }
    throw error;
  }
}

async function dispatchBuilder(paths, state, { env, owned, socket }) {
  const { id, task, project, model, branch, run } = state;
  if (owned) {
    const { status, body } = await runnerRequest("POST", "/v1/sessions", {
      project, harness: "codex", place: "openshell", model, taskId: task,
      builder: id, prompt: state.prompt ?? readFileSync(paths.brief, "utf8"),
    }, { socket, timeoutMs: BUILDER_START_TIMEOUT_MS + 10_000 });
    if (status !== 201) throw Object.assign(new Error(body?.error || "runner start returned HTTP " + status), { status });
    return { session: body.session, task, sandbox: paths.sandbox, worktree: paths.worktree, branch };
  }
  const started = await S.runTool(env.AI_COLLAB_SYSTEMD_RUN_BIN || "systemd-run", unitArgv(paths, project, task, env), { env, timeoutMs: GIT_TIMEOUT_MS });
  if (started.code !== 0) {
    updateState(paths, { phase: "failed", error: `systemd-run: ${(started.stderr || "").trim()}` });
    throw new Error(`systemd-run failed: ${(started.stderr || "").trim() || `exit ${started.code}`}`);
  }
  return { unit: paths.unit, task, sandbox: paths.sandbox, worktree: paths.worktree, branch };
}

function builderExited(state) {
  if (FINAL_PHASES.includes(state.phase)) return true;
  if (state.owned || !Number.isSafeInteger(state.pid) || state.pid <= 0) return false;
  try { process.kill(state.pid, 0); } catch (error) { return error.code === "ESRCH"; }
  return false;
}

export function builderAssignment(project, task, sessions, env) {
  // A build waiting for review, and a finished one, have nothing to recover.
  if (task.status === "done" || task.status === "review") return null;
  const paths = builderPaths(builderId(task.id), env);
  if (!existsSync(paths.state)) return null;
  let state;
  try { state = readState(paths); } catch { return null; }
  if (state.project !== project || state.task !== task.id) return null;
  if (!builderExited(state)) {
    return !state.owned && task.status === "building" && state.workspaceUploaded && !task.owner ? { builderUnit: state.unit } : null;
  }
  if (sessions.some(session => session.taskId === task.id && session.status !== "ended")) return null;
  if (task.owner && task.owner !== state.address && task.owner !== state.previousOwner) return null;
  const backup = join(paths.back, basename(state.worktree));
  return { recovery: {
    harness: state.harness, choices: BUILDER_HARNESSES.filter(harness => harness !== state.harness),
    worktree: state.worktree, branch: state.branch, commits: state.commits ?? 0,
    sandboxWorkspace: Boolean(state.sandboxCreated && state.workspaceUploaded && !state.collected),
    ...(existsSync(join(backup, ".git")) ? { backup } : {}),
  } };
}

export async function recoverBuilder(project, id, harness, sessions, env) {
  if (isProjectPaused({ project, stateDir: stateDir(env) })) throw new Error(PROJECT_PAUSED);
  const paths = builderPaths(builderId(id), env);
  const result = await withLock(join(paths.dir, "recovery"), async () => {
    const task = openTasks(project, env).get(id);
    const recovery = builderAssignment(project, task, sessions(), env)?.recovery;
    if (!recovery) throw new Error("This task has no recoverable builder");
    const state = readState(paths);
    const nextHarness = harness ?? state.harness;
    if (!BUILDER_HARNESSES.includes(nextHarness)) throw new Error("Unknown builder harness");
    const model = nextHarness === state.harness ? state.model : DEFAULT_MODEL[nextHarness];
    const limited = cursorLimitDetail(nextHarness, model, env);
    if (limited) throw new Error(limited);
    if (!state.owned && LIVE_STATES.includes(await unitState(state.unit, env))) throw new Error("The previous builder is still stopping");
    if (!existsSync(state.worktree)) throw new Error("The builder worktree is missing");
    const openshell = env.AI_COLLAB_OPENSHELL_BIN || "openshell";
    if (state.sandboxCreated) {
      if (recovery.sandboxWorkspace) await downloadWorktree(state, paths, openshell, env);
      const gone = await S.destroySandbox({ openshell, env, name: state.sandbox });
      if (!gone.ok) throw new Error("Could not clear the previous sandbox: " + gone.detail);
      updateState(paths, { sandboxCreated: false });
    }
    const brief = readFileSync(paths.brief, "utf8");
    const last = task.progress.at(-1);
    const context = ["Recover the unfinished assignment. Review the existing changes before continuing.",
      last && "Last task update: " + last.text].filter(Boolean).join("\n\n").slice(0, 1000);
    const prompt = brief.slice(0, PROMPT_MAX_CHARS - context.length - 2) + "\n\n" + context;
    const { id: builder, branch, base, root, worktree, unit, sandbox, run } = state;
    await launchBuilder(paths, {
      id: builder, task: id, project, branch, base, root, worktree, unit, sandbox, run, prompt,
      harness: nextHarness, model,
      previousOwner: task.owner, commits: recovery.commits,
      ...(existsSync(join(paths.back, basename(worktree), ".git")) ? { resume: join(paths.back, basename(worktree)) } : {}),
    }, { env });
  }, { staleMs: 2 * SYNC_TIMEOUT_MS + BUILDER_START_TIMEOUT_MS + 60_000 });
  if (!result.locked) throw new Error("Builder recovery is already in progress");
}

// systemd-run argv: a transient user unit, so a UI or runner restart cannot kill the builder.
function unitArgv(paths, project, taskId, env) {
  const pass = Object.entries(env).filter(([k]) => k === "PATH" || k === "HOME" || k === "CARGO_HOME" || k.startsWith("AI_COLLAB_") || k.startsWith("XDG_") || k === "CODEX_HOME");
  const setenv = [...pass.filter(([k]) => k !== "AI_COLLAB_PROJECT" && k !== "AI_COLLAB_BUILDER_TASK"), ["AI_COLLAB_PROJECT", project], ["AI_COLLAB_BUILDER_TASK", taskId]].map(([k, v]) => `--setenv=${k}=${v}`);
  return [
    "--user", "--collect", "--quiet", "--property=TimeoutStopSec=40min", "--property=KillMode=mixed", "--property=Restart=on-abnormal", `--unit=${paths.unit}`, `--working-directory=${paths.worktree}`,
    `--description=ai-collab builder ${basename(paths.dir)} (sandboxed)`, ...setenv,
    process.execPath, CLI_SCRIPT, "builder", "run", basename(paths.dir),
  ];
}

// The supervisor inside the unit: sandbox, run, copy back, commit, task status, cleanup.
async function runBuilder(id, { env, out, err }) {
  const paths = builderPaths(id, env);
  const state = readState(paths);
  if (state.owned) throw new Error("This builder is managed by the runner");
  const log = (line) => out.write(`builder ${id}: ${line}\n`);
  const openshell = env.AI_COLLAB_OPENSHELL_BIN || "openshell";
  let child = null;
  let stopping = false;
  const onTerm = () => {
    stopping = true;
    child?.kill("SIGTERM");
  };
  const { openDurable } = await import("./durable.mjs");
  const { acquireLock } = await import("../runner/lock.mjs");
  const release = acquireLock(join(paths.dir, "workflow.lock"));
  let durable;
  process.once("SIGTERM", onTerm);
  try {
    const journal = state.attempt ? "workflow-" + state.attempt + ".db" : "workflow.db";
    durable = openDurable(join(paths.dir, journal));
    durable.register("builder", async (wf) => {
      const context = { openshell, env, log, onChild: (process) => { child = process; } };
      let exitCode = null;
      try {
        const current = readState(paths);
        if (!current.settlement && !FINAL_PHASES.includes(current.phase)) {
          updateState(paths, { pid: process.pid });
          const staged = await wf.step("stage", () => {
            updateState(paths, { phase: "staging" });
            return stage(state, paths, context);
          });
          await wf.step("sandbox.create", async () => {
            await createSandbox({ openshell, env, name: state.sandbox, policy: paths.policy });
            updateState(paths, { phase: "uploading", sandboxCreated: true });
          }, { onCut: () => {
            if (!readState(paths).sandboxCreated) throw new Error("builder interrupted during sandbox creation; inspect " + state.sandbox);
          } });
          const authHash = await wf.step("sandbox.upload", async () => {
            await upload(state, paths, staged, context);
            updateState(paths, { workspaceUploaded: true });
            return staged.authHash;
          });
          staged.authHash = authHash;
          await wf.step("builder.ready", async () => {
            if (stopping) return;
            const tasks = openTasks(state.project, env);
            if (state.prompt || state.run || tasks.get(state.task).status !== "building") {
              await tasks.update(state.task, { status: "building", ...(state.prompt ? { owner: undefined } : {}), ...(state.run ? { run: state.run } : {}) });
            }
            if (!stopping) updateState(paths, { phase: "running" });
          });
          const attempt = await wf.step("agent.run", async () => {
            if (stopping) return { exitCode: 143 };
            const result = await runSandboxAgent(state, paths, staged, context);
            return stopping ? { exitCode: 143 } : result;
          }, {
            onCut: () => ({ exitCode: 143 }),
          });
          exitCode = attempt.exitCode;
          await wf.step("sandbox.collect", async () => {
            updateState(paths, { phase: "collecting", exitCode });
            await collect(state, paths, staged, context);
          });
          await wf.step("prepare settlement", async () => {
            if (attempt.usageLimit && exitCode !== 143) await retryLimitedBuilder(state, paths, context);
            else await prepareSettlement(state, paths, exitCode, { ...context, limitDetail: attempt.limitDetail });
          });
        }
      } catch (error) {
        err.write("builder " + id + ": " + error.message + "\n");
        const detail = "builder " + state.unit + " failed: " + oneLine(error.message);
        if (!readState(paths).settlement) {
          updateState(paths, { exitCode, settlement: { status: "blocked", detail, at: Date.now(), error: error.message } });
        }
      }
      // The persisted verdict makes publication repeatable even after the staging files are removed.
      try {
        const final = readState(paths);
        if (final.settlement && !FINAL_PHASES.includes(final.phase)) {
          await publishSettlement(state, paths, env);
        }
      } finally {
        await cleanupBuilderSandbox(state, paths, context);
      }
      return Number(Boolean(readState(paths).settlement?.error));
    });
    if (!durable.status(id)) return await durable.startWorkflow("builder", id, {});
    durable.recover();
    const result = await durable.result(id);
    const status = durable.status(id);
    if (status.status === "ERROR") throw new Error(status.error);
    return result;
  } finally {
    process.removeListener("SIGTERM", onTerm);
    try { await durable?.close(); } finally { release(); }
  }
}

async function runSandboxAgent(state, paths, staged, { openshell, env, log, onChild, signal }) {
  signal?.throwIfAborted();
  const original = state.prompt ?? readFileSync(paths.brief, "utf8");
  const brief = staged.builderCode ? original + "\nUse ai-collab-code run_code to batch related sh, read, grep and edit operations. "
    + "Check command exit codes and return only the findings needed for your next decision." : original;
  const launcher = staged.layout.file ? staged.layout.dir + "/" + basename(staged.layout.tree) : undefined;
  const argv = S.execArgv({
    openshell, sandbox: state.sandbox, workdir: staged.workdir, env: staged.execEnv,
    command: harnessCommand({ ...state, brief, workdir: staged.workdir, launcher, builderCode: staged.builderCode }),
  });
  log("running " + state.harness + " " + state.model + " in sandbox " + state.sandbox);
  const cursor = state.harness === "cursor";
  const codex = state.harness === "codex";
  const stdio = cursor || codex ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"];
  const child = spawn(argv[0], argv.slice(1), { env, stdio });
  onChild?.(child);
  const stop = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", stop, { once: true });
  // A Cursor builder's stream-json passes through to the log and becomes its OTLP trace (model, tokens, tool calls).
  const trace = cursor ? traceStream(child.stdout, { env, out: process.stdout, role: "builder", model: state.model }) : null;
  let errorTail = "";
  let cursorLimit;
  let usageLimit = false;
  if (codex) {
    let outputTail = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      process.stdout.write(chunk);
      outputTail = (outputTail + chunk).slice(-8192);
      // Codex stdout can contain assistant text alongside explicit errors.
      usageLimit ||= outputTail.split(/\r?\n/).some((line) =>
        /^\s*error:/i.test(line) && limitFromRunError("codex", line)?.wording === true);
    });
  }
  child.stderr?.setEncoding("utf8").on("data", (chunk) => {
    process.stderr.write(chunk);
    errorTail = (errorTail + chunk).slice(-8192);
    if (cursor) {
      cursorLimit = errorTail.match(/^ActionRequiredError:.*usage limit[^\r\n]*/im)?.[0] ?? cursorLimit;
    } else {
      usageLimit ||= limitFromRunError("codex", errorTail)?.wording === true;
    }
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => {
    signal?.removeEventListener("abort", stop);
    onChild?.(null);
  });
  signal?.throwIfAborted();
  await trace?.finish({ exitStatus: exitCode === 0 ? undefined : "error" });
  if (exitCode !== 0 && cursorLimit) {
    const limitPaths = cursorLimitPath(state.model, env);
    const reset = cursorLimit.match(/monthly cycle ends on (\d{1,2})\/(\d{1,2})\/(\d{4})/i);
    const reported = reset ? Date.UTC(Number(reset[3]), Number(reset[1]) - 1, Number(reset[2]) + 1) : 0;
    await withLock(limitPaths.state, async () => {
      const previous = existsSync(limitPaths.state) ? readState(limitPaths).until : 0;
      const until = reported > Date.now() ? reported : Date.now() + UNKNOWN_LIMIT_MS;
      writeState(limitPaths, { until: Math.max(until, previous) });
    });
  }
  return { exitCode, usageLimit: exitCode !== 0 && usageLimit,
    limitDetail: exitCode !== 0 && cursorLimit ? cursorLimitDetail(state.harness, state.model, env) : undefined };
}

export function cursorLimitPath(model, env) {
  const key = createHash("sha256").update(model.toLowerCase()).digest("hex");
  return { state: join(stateDir(env), "builder-limits", `cursor-${key}.json`) };
}

function cursorLimitDetail(harness, model, env) {
  if (harness !== "cursor") return undefined;
  const paths = cursorLimitPath(model, env);
  if (!existsSync(paths.state)) return undefined;
  const { until } = readState(paths);
  if (until > Date.now()) return `Cursor ${model} reached its usage limit. Choose another approved model or retry after ${new Date(until).toISOString()}.`;
}

// The harness a usage limit retries with: defaults.json "limitFallback" ("harness:model"), else Cursor DeepSeek.
export function limitFallback(env) {
  const parsed = parseHarnessModel(autoDefaults(env)?.limitFallback);
  if (parsed?.model && parsed.harness !== "codex" && DEFAULT_MODEL[parsed.harness]) return parsed;
  return { harness: "cursor", model: DEFAULT_MODEL.cursor };
}

function fallbackAttempts(env) {
  const extras = [
    { harness: "cursor", model: DEFAULT_MODEL.cursor },
    { harness: "opencode", model: DEFAULT_MODEL.opencode },
  ];
  const out = [];
  for (const item of [limitFallback(env), ...extras]) {
    if (!item?.harness || item.harness === "codex") continue;
    if (out.some((existing) => existing.harness === item.harness && existing.model === item.model)) continue;
    out.push(item);
  }
  return out;
}

async function retryLimitedBuilder(state, paths, context) {
  const { openshell, env, log, signal } = context;
  const sandbox = state.sandbox;
  let { fallback } = readState(paths);
  let resuming = fallback?.phase === "running";
  if (typeof fallback === "string") throw new Error("builder interrupted during fallback; inspect " + sandbox);
  fallback ??= { remaining: fallbackAttempts(env), detail: "Codex reached its usage limit. No fallback model is available." };
  while (fallback.remaining.length) {
    signal?.throwIfAborted();
    const attempt = { ...state, ...fallback.remaining[0] };
    if (!fallback.phase) {
      const limited = cursorLimitDetail(attempt.harness, attempt.model, env);
      if (limited) {
        fallback = { remaining: fallback.remaining.slice(1), detail: `Codex reached its usage limit. ${limited}` };
        continue;
      }
      fallback = { ...fallback, phase: "staging" };
      updateState(paths, { fallback, phase: "staging", workspaceUploaded: false, collected: false });
    }
    if (fallback.phase === "staging") {
      // Replacement is safe once the previous workspace and calls are on the host.
      const listed = await must(openshell, ["sandbox", "list", "-o", "json"], env, "sandbox list");
      if (S.parseSandboxList(listed.stdout).some(entry => entry.name === sandbox)) {
        const gone = await S.destroySandbox({ openshell, env, name: sandbox });
        if (!gone.ok) throw new Error("could not replace builder sandbox: " + gone.detail);
      }
      updateState(paths, { sandboxCreated: false });
      log(`Codex usage limit reached; retrying with ${attempt.harness}:${attempt.model}`);
      const staged = await stage(attempt, paths, { env, log, resume: join(paths.back, basename(state.worktree)) });
      await uploadBuilderSandbox(attempt, paths, staged, context);
      if (existsSync(paths.out)) await S.uploadAll({ openshell, env, sandbox, local: paths.out, remote: SANDBOX });
      fallback = { ...fallback, staged, phase: "running" };
      updateState(paths, { fallback, phase: "running", workspaceUploaded: true });
    }
    if (fallback.phase === "running") {
      const agent = resuming ? {
        ...attempt,
        prompt: builderResumePrompt(attempt.prompt ?? readFileSync(paths.brief, "utf8")),
      } : attempt;
      resuming = false;
      const result = await runSandboxAgent(agent, paths, fallback.staged, context);
      fallback = { ...fallback, phase: "collecting", result };
      updateState(paths, { fallback, phase: "collecting", exitCode: result.exitCode });
    }
    if (fallback.phase === "collecting") {
      await collect(attempt, paths, fallback.staged, context);
      fallback = { ...fallback, phase: "collected" };
      updateState(paths, { fallback, phase: "collected" });
    }
    const { exitCode, limitDetail } = fallback.result;
    if (!limitDetail) {
      await prepareSettlement(attempt, paths, exitCode, context);
      return;
    }
    fallback = { remaining: fallback.remaining.slice(1), detail: `Codex reached its usage limit. ${limitDetail}` };
    updateState(paths, { fallback });
  }
  await prepareSettlement(state, paths, readState(paths).exitCode, { env, log, limitDetail: fallback.detail });
}

// Runner-owned builders reuse the standalone staging and landing paths.
export function ownedBuilder(project, id, env) {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error("Invalid builder id");
  const state = readState(builderPaths(id, env));
  if (!state.owned || state.id !== id || state.harness !== "codex" || state.project !== project) throw new Error("Unknown owned builder");
  return state;
}

export function markOwnedBuilderFailed(project, id, address, error, env) {
  const paths = builderPaths(id, env);
  if (!existsSync(paths.state)) return;
  const current = ownedBuilder(project, id, env);
  if (current.address !== address || FINAL_PHASES.includes(current.phase)) return;
  updateState(paths, { phase: "failed", ended: Date.now(), error });
}

export async function stageOwnedBuilder(state, env, log) {
  const paths = builderPaths(state.id, env);
  const openshell = env.AI_COLLAB_OPENSHELL_BIN || "openshell";
  const current = readState(paths);
  updateState(paths, { phase: "staging" });
  const staged = await stage(state, paths, { env, log });
  const context = { openshell, env, log };
  // Only a sandbox recorded as ours can be reused after a partial upload.
  if (!current.sandboxCreated) await uploadBuilderSandbox(state, paths, staged, context);
  else if (!current.workspaceUploaded) await upload(state, paths, staged, context);
  updateState(paths, { workspaceUploaded: true });
  return {
    workdir: staged.workdir,
    layout: { auth: "" },
    argv: S.execArgv({
      openshell, sandbox: state.sandbox, workdir: staged.workdir,
      env: { ...staged.execEnv, AI_COLLAB_OWNED: "codex" },
      command: [`${staged.layout.dir}/${basename(staged.layout.tree)}${staged.layout.launcher}`, "app-server", "-c", "thread_unload_delay_secs=0"],
    }),
  };
}

export function builderResumePrompt(prompt) {
  const instruction = "The runner restarted during this assignment. Inspect the existing workspace and continue the task. Preserve any work already completed.";
  return instruction + "\n\n" + prompt.slice(0, PROMPT_MAX_CHARS - instruction.length - 2);
}

export async function claimOwnedBuilder(state, address, env) {
  // A task already attached to a run retains that association.
  await openTasks(state.project, env).update(state.task, { owner: address, status: "building", ...(state.run ? { run: state.run } : {}) });
  updateState(builderPaths(state.id, env), { phase: "running", address });
}

export async function finishOwnedBuilder(state, staged, exitCode, env, log, failure, usageLimit = false, signal) {
  const paths = builderPaths(state.id, env);
  const openshell = env.AI_COLLAB_OPENSHELL_BIN || "openshell";
  const taskEnv = { ...env, AI_COLLAB_PROJECT: state.project };
  const current = readState(paths);
  if (!FINAL_PHASES.includes(current.phase)) {
    if (!current.settlement) {
      try {
        if (failure) throw new Error(failure);
        signal?.throwIfAborted();
        if (!current.fallback && current.phase !== "collected") {
          await collect(state, paths, staged, { openshell, env, log });
          updateState(paths, { phase: "collected", exitCode });
        }
        if (usageLimit || current.fallback) await retryLimitedBuilder(state, paths, { openshell, env: taskEnv, log, signal });
        else await prepareSettlement(state, paths, current.phase === "collected" ? current.exitCode : exitCode, { env: taskEnv, log });
      } catch (error) {
        signal?.throwIfAborted();
        const detail = "builder " + state.id + " failed: " + oneLine(error.message);
        updateState(paths, { settlement: { status: "blocked", detail, at: Date.now(), error: error.message } });
      }
    }
    await publishSettlement(state, paths, taskEnv);
  }
  await cleanupBuilderSandbox(state, paths, { openshell, env, log });
}

async function cleanupBuilderSandbox(state, paths, { openshell, env, log }) {
  const final = readState(paths);
  if (final.sandboxCreated && (!final.workspaceUploaded || final.collected)) {
    const gone = await S.destroySandbox({ openshell, env, name: state.sandbox });
    log(gone.ok ? `sandbox ${state.sandbox} deleted` : `sandbox delete failed: ${gone.detail}`);
    updateState(paths, { sandboxDeleted: gone.ok, sandboxCreated: !gone.ok });
  }
}

// Builds the host-side staging: a self-contained clone, the tools tree, the sandbox home and the policy.
async function stage(state, paths, { env, log, resume }) {
  rmSync(paths.stage, { recursive: true, force: true });
  mkdirSync(paths.stage, { recursive: true });
  const name = basename(state.worktree);
  const clone = join(paths.stage, name);
  // The worktree's .git is a file pointing into the host repo; the sandbox gets a clone with its own .git.
  resume ??= state.resume;
  if (resume) cpSync(resume, clone, { recursive: true, verbatimSymlinks: true });
  else await git(paths.stage, ["clone", "--quiet", "--no-hardlinks", "--single-branch", "--branch", state.branch, state.root, clone], env);
  if (!resume) await git(clone, ["remote", "remove", "origin"], env);
  await git(clone, ["branch", "--force", BASE_REF, state.base], env);
  // The sandbox's node_modules is a symlink, which the repo's "node_modules/" pattern does not ignore.
  mkdirSync(join(clone, ".git", "info"), { recursive: true });
  appendFileSync(join(clone, ".git", "info", "exclude"), "\nnode_modules\n");
  for (const key of ["user.name", "user.email"]) {
    const value = (await S.runTool("git", ["-C", state.root, "config", key], { env })).stdout.trim();
    if (value) await git(clone, ["config", key, value], env);
  }
  const tools = join(paths.stage, "tools");
  mkdirSync(join(tools, "bin"), { recursive: true });
  mkdirSync(join(tools, "tasks"), { recursive: true });
  writeFileSync(join(tools, "bin", "ai-collab"), AI_COLLAB_SHIM, { mode: 0o755 });
  writeFileSync(join(tools, "bin", "ob-capture"), CAPTURE_SHIM, { mode: 0o755 });
  for (const t of openTasks(state.project, env).list()) writeFileSync(join(tools, "tasks", `${t.id}.json`), `${JSON.stringify(t, null, 2)}\n`);
  const src = toolSources(state, env);
  for (const [bin, from] of [["git", src.git], ["oncebitten", src.oncebitten]]) {
    if (from) { cpSync(from, join(tools, "bin", bin)); chmodSync(join(tools, "bin", bin), 0o755); } else log(`no ${bin} found on the host; the sandbox has none`);
  }
  const libs = src.node ? await sharedLibs(src.node, env) : [];
  if (libs.length) {
    // The image lacks some of node's libraries (libatomic.so.1, measured 2026-11-22); glibc itself stays the image's.
    mkdirSync(join(tools, "lib"), { recursive: true });
    for (const lib of libs) {
      let resolved;
      try {
        resolved = realpathSync(lib);
      } catch {
        continue;
      }
      if (!statSync(resolved).isFile()) continue;
      // Named by the soname ldd printed (libatomic.so.1), not the real file's name (libatomic.so.1.2.0), or the loader misses it.
      copyFileSync(resolved, join(tools, "lib", basename(lib)));
    }
  }
  if (src.npm) {
    symlinkSync(`${TOOLS}/node/lib/node_modules/npm/bin/npm-cli.js`, join(tools, "bin", "npm"));
    symlinkSync(`${TOOLS}/node/lib/node_modules/npm/bin/npx-cli.js`, join(tools, "bin", "npx"));
  }
  const layout = harnessLayout(state.harness, src);
  if (!layout.tree) throw new Error(`no ${state.harness} install found on the host`);
  const inTree = `${layout.dir}/${basename(layout.tree)}`;
  // Relative, so the link resolves wherever the sandbox root is mounted.
  symlinkSync(`../..${inTree.slice(SANDBOX.length)}${layout.launcher}`, join(tools, "bin", layout.name));
  const home = join(paths.stage, "home");
  const hookDir = join(home, layout.hookDir);
  mkdirSync(hookDir, { recursive: true });
  const events = state.harness === "opencode" ? [] : hostCaptureEvents(state.harness, src.hostHooks);
  const workdir = `${WORK}/${name}`;
  const builderCode = Boolean(src.node && ["cursor", "opencode"].includes(state.harness));
  if (src.node && (builderCode || state.harness === "claude")) {
    for (const part of APP_PARTS) if (existsSync(join(APP_ROOT, part))) cpSync(join(APP_ROOT, part), join(tools, "ai-collab", part), { recursive: true });
  }
  if (builderCode) {
    const command = `${TOOLS}/node/bin/node`;
    const args = [`${APP_IN}/${CODE_MCP}`, "--builder-local", workdir];
    const servers = { "ai-collab-code": state.harness === "cursor"
      ? { command, args }
      : { type: "local", command: [command, ...args], codemode: false, timeout: { execution: 150_000 } } };
    const cursor = state.harness === "cursor";
    writeFileSync(join(hookDir, cursor ? "mcp.json" : "opencode.json"), JSON.stringify(cursor ? { mcpServers: servers } : { mcp: { servers } }));
  }
  if (state.harness === "claude") {
    const codeMode = existsSync(join(APP_ROOT, CODE_MCP));
    writeFileSync(join(hookDir, basename(CLAUDE_SETTINGS_IN)), `${JSON.stringify(claudeSettings(events), null, 2)}\n`);
    writeFileSync(join(hookDir, basename(CLAUDE_MCP_IN)), `${JSON.stringify(claudeMcpConfig({ node: src.node, project: state.project, codeMode }), null, 2)}\n`);
    log(`claude: lean settings, MCP servers ${Object.keys(claudeMcpConfig({ node: src.node, project: state.project, codeMode }).mcpServers).join(", ") || "none"}`);
  } else if (state.harness !== "opencode") {
    writeFileSync(join(hookDir, "hooks.json"), `${JSON.stringify(captureHooks(state.harness, events), null, 2)}\n`);
  }
  // Hooks on and the worktree trusted, as the host's own config has them; whether `codex exec` then fires them is UNVERIFIED.
  if (state.harness === "codex") writeFileSync(join(hookDir, "config.toml"), `[features]\nhooks = true\n\n[projects."${workdir}"]\ntrust_level = "trusted"\n`);
  // Every publishing sandbox gets the token, not only Claude. tokenFile is the uploaded path, never the host path.
  if (src.ntfyToken || (state.harness === "claude" && src.node)) {
    const config = join(home, ".config", "ai-collab");
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "defaults.json"), `${JSON.stringify({ url: `http://${NTFY_HOST}:${NTFY_PORT}`, ...(src.ntfyToken ? { tokenFile: NTFY_TOKEN_IN } : {}), peers: "claude,codex,cursor" }, null, 2)}\n`);
  }
  const binaries = layout.binaries(inTree);
  const ntfyBinaries = src.node ? [`${TOOLS}/node/bin/node`] : [];
  writeFileSync(paths.policy, `${JSON.stringify(builderPolicy({ harness: state.harness, binaries, ntfyBinaries }), null, 2)}\n`);
  // No SSL_CERT_FILE: the login shell points it at the CA that OpenShell terminates TLS with.
  const execEnv = {
    HOME: HOME_IN, XDG_CONFIG_HOME: `${HOME_IN}/.config`, CODEX_HOME: `${HOME_IN}/.codex`, PATH: SANDBOX_PATH, TMPDIR: "/tmp",
    AI_COLLAB_PROJECT: state.project,
    AI_COLLAB_BUILDER_OUT: OUT, AI_COLLAB_BUILDER_TASKS: `${TOOLS}/tasks`, AI_COLLAB_BUILDER: state.id, AI_COLLAB_BUILDER_TASK: state.task,
    ...(src.gitCore ? { GIT_EXEC_PATH: `${TOOLS}/git-core` } : {}),
    ...(libs.length ? { LD_LIBRARY_PATH: `${TOOLS}/lib` } : {}),
    ...(state.harness === "claude" ? CLAUDE_ENV : {}),
    ...(state.harness === "cursor" ? CURSOR_ENV : {}),
  };
  return { clone, tools, home, src, layout, workdir, execEnv, builderCode };
}

// Where each harness's install lives on the host and in the sandbox, its launcher, auth file and hook file.
function harnessLayout(harness, src) {
  const all = (inTree) => (dir) => S.executables(dir).map((f) => `${inTree}/${f}`);
  if (harness === "cursor") {
    return { tree: src.cursorTree, dir: CURSOR_DIR, launcher: "/cursor-agent", name: "cursor-agent", hookDir: ".cursor", auth: src.cursorAuth, authDir: `${HOME_IN}/.config/cursor`, binaries: (inTree) => all(inTree)(src.cursorTree) };
  }
  if (harness === "codex") {
    return { tree: src.codexTree, dir: CODEX_DIR, launcher: "/bin/codex", name: "codex", hookDir: ".codex", auth: src.codexAuth, authDir: `${HOME_IN}/.codex`, binaries: (inTree) => all(`${inTree}/bin`)(join(src.codexTree, "bin")) };
  }
  // Claude Code is one native binary, uploaded as a file into /sandbox/claude.
  if (harness === "opencode") {
    return { tree: src.opencodeBin, file: true, dir: OPENCODE_DIR, launcher: "", name: "opencode", hookDir: ".config/opencode", auth: src.opencodeAuth, authDir: `${HOME_IN}/.local/share/opencode`, binaries: (inTree) => [inTree] };
  }
  return { tree: src.claudeBin, file: true, dir: CLAUDE_DIR, launcher: "", name: "claude", hookDir: ".claude", auth: src.claudeAuth, authDir: `${HOME_IN}/.claude`, binaries: (inTree) => [inTree] };
}

// Host sources of what the sandbox needs; an AI_COLLAB_BUILDER_* override of "none" leaves one out.
export function toolSources(state, env) {
  const path = env.PATH || "";
  const pick = (key, fallback) => (env[key] === "none" ? "" : env[key] || fallback());
  const real = (p) => { try { return p ? realpathSync(p) : ""; } catch { return ""; } };
  const node = pick("AI_COLLAB_BUILDER_NODE", () => real(process.execPath));
  const npm = node ? join(dirname(dirname(node)), "lib", "node_modules", "npm") : "";
  const home = env.HOME || homedir();
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  const cursorBin = findExecutable(cursorBinary(path), path);
  const codexBin = findExecutable("codex", path);
  const claudeHome = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const hostHooks = { cursor: join(home, ".cursor", "hooks.json"), codex: join(codexHome, "hooks.json"), claude: join(claudeHome, "settings.json") };
  return {
    git: pick("AI_COLLAB_BUILDER_GIT", () => real(findExecutable("git", path))),
    gitCore: pick("AI_COLLAB_BUILDER_GIT_CORE", () => (existsSync("/usr/lib/git-core") ? "/usr/lib/git-core" : "")),
    oncebitten: pick("AI_COLLAB_BUILDER_ONCEBITTEN", () => real(findOncebitten(env))),
    node, npm: node && existsSync(npm) ? npm : "",
    nodeModules: pick("AI_COLLAB_BUILDER_NODE_MODULES", () => (existsSync(join(state.root, "node_modules")) ? real(join(state.root, "node_modules")) : "")),
    cursorTree: pick("AI_COLLAB_CURSOR_TREE", () => { const r = real(cursorBin); return r && existsSync(join(dirname(r), "node")) ? dirname(r) : ""; }),
    codexTree: pick("AI_COLLAB_CODEX_TREE", () => { const r = real(codexBin); return r ? dirname(dirname(r)) : ""; }),
    cursorAuth: [join(configHome, "cursor", "auth.json"), join(home, ".cursor", "auth.json")].find((p) => existsSync(p)) || "",
    // A CODEX_HOME without a login (a test shell's temp dir, say) falls back to the user's own ~/.codex login.
    codexAuth: [join(codexHome, "auth.json"), join(homedir(), ".codex", "auth.json")].find((p) => existsSync(p)) || "",
    opencodeBin: pick("AI_COLLAB_OPENCODE_BIN", () => real(findExecutable("opencode", path))),
    opencodeAuth: pick("AI_COLLAB_BUILDER_OPENCODE_AUTH", () => {
      const file = join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode", "auth.json");
      return existsSync(file) ? file : "";
    }),
    claudeBin: pick("AI_COLLAB_CLAUDE_BIN", () => real(findExecutable("claude", path))),
    claudeAuth: existsSync(join(claudeHome, ".credentials.json")) ? join(claudeHome, ".credentials.json") : "",
    ntfyToken: pick("AI_COLLAB_BUILDER_NTFY_TOKEN", () => S.hostTokenFile(env)),
    hostHooks: hostHooks[state.harness],
  };
}

function findOncebitten(env) {
  const cargoBin = join(env.CARGO_HOME || join(env.HOME || homedir(), ".cargo"), "bin");
  return findExecutable("oncebitten", env.PATH) || findExecutable("oncebitten", cargoBin);
}

/** The shared libraries `ldd` resolves for a binary, minus glibc's own, which must match the image's loader. */
export async function sharedLibs(bin, env = process.env) {
  const res = await S.runTool("ldd", [bin], { env });
  if (res.code !== 0) return [];
  return [...res.stdout.matchAll(/=>\s+(\/\S+)/g)].map((m) => m[1].replace(/\/+$/, "")).filter((p) => {
    if (GLIBC_LIB.test(basename(p))) return false;
    try {
      return statSync(realpathSync(p)).isFile();
    } catch {
      return false;
    }
  });
}

// Creates this builder's own sandbox; an existing one with the name is never reused or touched.
async function createSandbox({ openshell, env, name, policy }) {
  const list = await S.runTool(openshell, ["sandbox", "list", "-o", "json"], { env });
  if (list.code !== 0) throw new Error(`openshell sandbox list failed: ${list.stderr.trim() || `exit ${list.code}`}`);
  if (S.parseSandboxList(list.stdout).some((s) => s?.name === name)) throw new Error(`sandbox ${name} already exists`);
  await must(openshell, ["sandbox", "create", "--name", name, "--no-tty", "--detach", "--policy", policy], env, "sandbox create");
}

function must(bin, args, env, what) {
  return S.must(bin, args, { env, timeoutMs: SYNC_TIMEOUT_MS, what });
}

async function uploadBuilderSandbox(state, paths, staged, context) {
  const { openshell, env } = context;
  await createSandbox({ openshell, env, name: state.sandbox, policy: paths.policy });
  updateState(paths, { sandboxCreated: true });
  await upload(state, paths, staged, context);
}

async function upload(state, paths, staged, { openshell, env, log }) {
  const { src, layout } = staged;
  const uploaded = await S.stageAndUpload({
    openshell, env, sandbox: state.sandbox, log,
    staged: { clone: staged.clone, tools: staged.tools, home: staged.home, workdir: staged.workdir, node: src.node, gitCore: src.gitCore, npm: src.npm, nodeModules: src.nodeModules, ntfyToken: src.ntfyToken },
    layout, style: {}, authMissing: `no host ${state.harness} credentials; the harness will ask to log in`, secretTmp: "ai-collab-builder-auth-",
  });
  if (layout.auth) staged.authHash = uploaded.authHash;
}

// Copies a credentials file the harness refreshed inside back to the host, unless the host's changed meanwhile; never logs it.
async function keepRefreshedAuth(state, staged, { openshell, env, log }) {
  const { layout } = staged;
  if (!layout.auth || !staged.authHash) return;
  const remote = `${layout.authDir}/${basename(layout.auth)}`;
  const res = await S.runTool(openshell, S.execArgv({ openshell, sandbox: state.sandbox, command: ["cat", remote] }).slice(1), { env });
  if (res.code !== 0 || !res.stdout.trim()) return;
  const inside = createHash("sha256").update(res.stdout).digest("hex");
  if (inside === staged.authHash) return;
  if (S.fileHash(layout.auth) !== staged.authHash) { log(`${state.harness} credentials changed on both sides; kept the host's`); return; }
  const tmp = `${layout.auth}.builder-${process.pid}`;
  writeFileSync(tmp, res.stdout, { mode: 0o600 });
  renameSync(tmp, layout.auth);
  log(`${state.harness} refreshed its credentials in the sandbox; copied them back to the host`);
}

// Downloads the worktree clone and the recorded hook payloads and task calls.
async function collect(state, paths, staged, { openshell, env, log }) {
  log(`collecting workspace from sandbox ${state.sandbox}`);
  await keepRefreshedAuth(state, staged, { openshell, env, log });
  await S.runTool(openshell, S.execArgv({ openshell, sandbox: state.sandbox, command: ["rm", "-f", `${staged.workdir}/node_modules`] }).slice(1), { env });
  await downloadWorktree(state, paths, openshell, env);
  updateState(paths, { collected: true });
  rmSync(paths.out, { recursive: true, force: true });
  const got = await S.runTool(openshell, ["sandbox", "download", state.sandbox, OUT, paths.out], { env, timeoutMs: SYNC_TIMEOUT_MS });
  if (got.code !== 0) log("no recorded task calls or hook payloads");
}

async function downloadWorktree(state, paths, openshell, env) {
  const name = basename(state.worktree);
  const incoming = mkdtempSync(join(paths.dir, "download-"));
  try {
    await must(openshell, ["sandbox", "download", state.sandbox, `${WORK}/${name}`, join(incoming, name)], env, "sandbox download");
    if (!existsSync(join(incoming, name, ".git"))) throw new Error("Downloaded workspace is missing its Git repository");
    rmSync(paths.back, { recursive: true, force: true });
    renameSync(incoming, paths.back);
  } finally {
    rmSync(incoming, { recursive: true, force: true });
  }
}

// Save the verified verdict before publishing it.
async function prepareSettlement(state, paths, exitCode, { env, log, limitDetail }) {
  const back = join(paths.back, basename(state.worktree));
  const hostGit = (cwd, args) => git(cwd, args, env);
  const trailer = `Assisted-by: ${{ cursor: "Cursor", codex: "Codex", claude: "Claude", opencode: "OpenCode" }[state.harness]}:${state.model}`;
  if (await S.commitUncommitted({ git: hostGit, repo: back, message: `chore(builder): uncommitted work from ${state.id}`, trailer })) log("committed the agent's uncommitted changes on the host");
  const commits = await S.commitsAhead({ git: hostGit, repo: back, base: state.base });
  let landed = false;
  let commit;
  let landError = "";
  if (commits > 0) {
    try {
      commit = (await git(back, ["rev-parse", "HEAD"], env)).trim();
      await git(state.worktree, ["fetch", "--quiet", back, "HEAD"], env);
      await git(state.worktree, ["merge", "--quiet", "--ff-only", "FETCH_HEAD"], env);
      landed = true;
      log(`${commits} commit(s) on ${state.branch}`);
    } catch (error) {
      landError = `could not fast-forward ${state.branch}; the work is kept in ${back}: ${oneLine(error.message)}`;
      log(landError);
    }
  }
  // Report sinks do not all offer idempotency keys. An interrupted replay requires operator review.
  if (readState(paths).replayingReports) throw new Error("builder interrupted while replaying reports; inspect " + paths.out);
  updateState(paths, { replayingReports: true });
  const captured = await replayCaptures(state, paths, env, log);
  const check = landed ? await oncebittenCheck(state, env) : { code: 0, text: "" };
  const requested = await replayCalls(state, paths, env, log);
  let status = "blocked";
  let detail = limitDetail;
  if (landError) detail = landError;
  else if (check.code !== 0) {
    const reason = check.code === 1 ? "fired" : "could not run";
    detail = "oncebitten check --base " + BASE_REF + " " + reason + ": " + (check.text || "exit " + check.code);
    log(detail);
  } else if (requested !== "blocked") {
    if (exitCode === 0 && landed) status = "review";
    else detail ??= `builder ${state.unit} exited ${exitCode} with ${commits} commit(s) and ${requested ? "requested " + requested : "set no status"}`;
  }
  // A finished build waits for the operator's verdict, so the packet rides with the settlement the runner saved above.
  const review = status === "review" ? reviewPacket({
    submission: randomUUID(), commit, base: state.base, branch: state.branch,
    criteria: reviewCriteria(state, paths, env), check, numstat: await reviewNumstat(back, state.base, env),
  }) : undefined;
  const outcome = `builder ${state.unit}: exit ${exitCode}, ${commits} commit(s) on ${state.branch}, ${captured} oncebitten capture(s)`;
  const progress = limitDetail ? `${limitDetail} ${outcome}` : outcome;
  updateState(paths, { settlement: { commits, landed, status, detail, captured, oncebitten: landed ? check.code : null, checkText: check.text, progress, ...(review ? { review } : {}), at: Date.now() } });
  log(`settled as ${status} (agent exit ${exitCode}, requested ${requested || "no status"}, oncebitten ${landed ? "exit " + check.code : "skipped"})`);
}

// The criteria a reviewer judges the build against: the task's own detail, else the brief's opening paragraph.
function reviewCriteria(state, paths, env) {
  let detail = "";
  try { detail = openTasks(state.project, env).get(state.task).detail || ""; } catch { /* store unreadable; fall back to the brief */ }
  if (detail.trim()) return detail;
  try {
    const brief = readFileSync(paths.brief, "utf8").split("\n## Builder sandbox\n")[0].trim();
    return brief.split(/\n{2,}/)[0] || brief;
  } catch { return ""; }
}

// Per-file line counts for the packet; a missing range is not worth failing the settlement over.
async function reviewNumstat(back, base, env) {
  try { return await git(back, ["diff", "--numstat", `${base}..HEAD`], env); } catch { return ""; }
}

async function publishSettlement(state, paths, env) {
  const { at, progress, detail, ...result } = readState(paths).settlement;
  const tasks = openTasks(state.project, env);
  const entry = { by: state.unit, text: clipProgress(progress || detail).text };
  // The progress entry and verdict are written together. On retry the entry proves publication.
  if (!tasks.get(state.task).progress.some(p => p.at === at && p.by === entry.by && p.text === entry.text)) {
    // A runner killed while holding this lock can leave it behind until the stale-lock timeout.
    await tasks.update(state.task, { status: result.status, ...(result.review ? { review: result.review } : {}), ...(detail !== undefined ? { detail } : {}), progress: entry }, at, { waitMs: 45_000 });
  }
  if (result.landed) rmSync(paths.back, { recursive: true, force: true });
  rmSync(paths.stage, { recursive: true, force: true });
  updateState(paths, { phase: result.error ? "failed" : "finished", ended: Date.now(), ...result });
  await cleanBuilders(env);
}

// Feeds every saved hook payload to the host's `oncebitten capture`, with sandbox paths mapped to the host worktree.
async function replayCaptures(state, paths, env, log) {
  const dir = join(paths.out, "oncebitten");
  if (!existsSync(dir)) return 0;
  const bin = env.AI_COLLAB_ONCEBITTEN_BIN || findOncebitten(env);
  if (!bin) { log("oncebitten is not installed on the host; captures dropped"); return 0; }
  const workdir = `${WORK}/${basename(state.worktree)}`;
  let count = 0;
  for (const file of readdirSync(dir).sort()) {
    const host = file.replace(/\.json$/, "").split("-").slice(2).join("-") || state.harness;
    const payload = readFileSync(join(dir, file), "utf8").split(workdir).join(state.worktree);
    if (!payload.trim()) continue;
    const res = await S.runTool(bin, ["capture", "--host", BUILDER_HARNESSES.includes(host) ? host : state.harness], { env, cwd: state.worktree, stdin: payload });
    if (res.code === 0) count += 1;
  }
  return count;
}

// Own-task status assignments are requests. Replay other fields and progress as usual.
async function replayCalls(state, paths, env, log) {
  const dir = join(paths.out, "ai-collab");
  let requested = "";
  if (!existsSync(dir)) return requested;
  for (const file of readdirSync(dir).sort()) {
    const argv = parseRecordedCall(readFileSync(join(dir, file), "utf8"));
    if (!replayable(argv)) { log(`skipped recorded call: ${argv.slice(0, 2).join(" ")}`); continue; }
    let status;
    if (argv[1] === "set" && argv[2] === state.task) {
      const fields = argv.slice(3);
      status = fields.findLast(a => a.startsWith("status="))?.slice(7);
      if (status !== undefined && !STATUSES.includes(status)) {
        log(`skipped recorded call with invalid status: ${status}`);
        continue;
      }
      argv.splice(3, fields.length, ...fields.filter(a => !a.startsWith("status=")));
    }
    try {
      if (argv.length > 3) await taskCli(argv, env);
      if (status) requested = status;
    } catch (error) {
      log(`recorded call failed: ${error.message}`);
    }
  }
  return requested;
}

async function oncebittenCheck(state, env) {
  const bin = env.AI_COLLAB_ONCEBITTEN_BIN || findOncebitten(env);
  if (!bin) {
    const lock = join(state.worktree, ".oncebitten", "rules.lock");
    const local = join(dirname(lock), "rules.local");
    const configured = (existsSync(local) && readdirSync(local).length > 0) || (existsSync(lock) && !/^source\s*=\s*\[\s*\]$/.test(readFileSync(lock, "utf8").trim()));
    return configured ? { code: 2, text: "oncebitten is not installed" } : { code: 0, text: "" };
  }
  const res = await S.runTool(bin, ["check", "--base", state.base], { env, cwd: state.worktree, timeoutMs: GIT_TIMEOUT_MS });
  return { code: res.code, text: oneLine(`${res.stdout} ${res.stderr}`).slice(0, 300) };
}

// Runs `ai-collab task ...` in-process; throws with its stderr on a non-zero exit.
async function taskCli(argv, env) {
  const { runCli } = await import("./cli.mjs");
  let errText = "";
  const sink = { write: () => true };
  const code = await runCli(argv, { env, stdout: sink, stderr: { write: (s) => { errText += s; return true; } } });
  if (code !== 0) throw new Error(oneLine(errText) || `ai-collab ${argv.join(" ")} exited ${code}`);
}

function listBuilders(argv, { env, out, fail }) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--all")) return fail("list");
  const all = argv[0] === "--all";
  const root = join(stateDir(env), "builders");
  const ids = existsSync(root) ? readdirSync(root).sort() : [];
  return Promise.all(ids.map(async (id) => {
    const paths = builderPaths(id, env);
    let state;
    try { state = readState(paths); } catch { return null; }
    if (state.owned) {
      if (!all && FINAL_PHASES.includes(state.phase)) return null;
      return [state.address || state.unit, state.task, state.sandbox, state.phase, state.phase].join("\t");
    }
    const active = await unitState(state.unit, env);
    if (!all && !LIVE_STATES.includes(active) && FINAL_PHASES.includes(state.phase)) return null;
    return `${state.unit}\t${state.task}\t${state.sandbox}\t${state.phase}\t${active}`;
  })).then((rows) => {
    for (const row of rows.filter(Boolean)) out.write(`${row}\n`);
    return 0;
  });
}

// Stops a builder this command started (it has a state file), then deletes its sandbox.
async function stopBuilder(id, { env, out, err }) {
  const paths = builderPaths(builderId(id), env);
  let state;
  try { state = readState(paths); } catch { err.write(`ai-collab: builder stop: no builder ${id} started by ai-collab builder start\n`); return 1; }
  if (state.owned) {
    if (!state.address) throw new Error("builder session has not been claimed");
    const route = state.address.replace("#", "/");
    const { status, body } = await runnerRequest("DELETE", "/v1/sessions/" + route, undefined, { socket: runnerSocket(env) });
    if (status !== 200) throw new Error(body?.error || "runner stop returned HTTP " + status);
    out.write([state.address, body.status].join("\t") + "\n");
    return 0;
  }
  const stopped = await S.runTool(env.AI_COLLAB_SYSTEMCTL_BIN || "systemctl", ["--user", "stop", state.unit], { env, timeoutMs: 41 * 60_000 });
  const current = readState(paths);
  if (stopped.code === 0) {
    if (current.started === state.started && !FINAL_PHASES.includes(current.phase)) {
      updateState(paths, { phase: "stopped", ended: Date.now() });
    }
    await cleanBuilders(env);
    const sandbox = current.sandboxDeleted ? "sandbox deleted" : current.sandboxCreated ? "sandbox retained" : "no sandbox";
    out.write([state.unit, "stopped", sandbox].join("\t") + "\n");
  } else {
    out.write([state.unit, "stop failed: " + (stopped.stderr || "").trim()].join("\t") + "\n");
  }
  return stopped.code === 0 ? 0 : 1;
}

async function unitState(unit, env) {
  const res = await S.runTool(env.AI_COLLAB_SYSTEMCTL_BIN || "systemctl", ["--user", "show", "-p", "ActiveState", "--value", unit], { env });
  return res.code === 0 ? res.stdout.trim() || "unknown" : "unknown";
}

async function git(cwd, args, env) {
  const res = await S.runTool("git", ["-C", cwd, ...args], { env, timeoutMs: GIT_TIMEOUT_MS });
  if (res.code !== 0) throw new Error(`git ${args[0]} failed: ${(res.stderr || "").trim() || `exit ${res.code}`}`);
  return res.stdout;
}

function oneLine(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function readState(paths) {
  return JSON.parse(readFileSync(paths.state, "utf8"));
}

function writeState(paths, state) {
  writeJson(paths.state, state, { indent: 2 });
}

function updateState(paths, patch) {
  let state = {};
  try { state = readState(paths); } catch { /* first write */ }
  writeState(paths, { ...state, ...patch, updated: Date.now() });
}
