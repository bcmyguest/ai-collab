// Launch of a headless session: refusals, placement, the child environment, and startSession.
import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { ALLOW_HOST_AGENT_ENV, hostAgentRefusal } from "../agent-guard.mjs";
import { claudePermissionSetting, listProjects, sessionLabel, startPlaceSetting } from "../config.mjs";
import { REQUIRE_RUN_CODE_ENV, resolveCodeMode } from "../code-mode.mjs";
import { SYSTEM_PROMPT_ENV } from "../machine-prompt.mjs";
import { recordedMode, WAKE_ENV } from "../mode.mjs";
import { isProjectPaused, PROJECT_PAUSED } from "../project-pause.ts";
import { runnerSocket } from "../runner-request.mjs";
import { argv, childPath, claudePermissionError, claudePermissionFlag, CURSOR_BINARIES, cursorCommandFor, type Command, HARNESSES, type Harness, LAUNCH_BINARY, modelShape } from "../harness.ts";
import { modeFlags } from "../../web/lib/start-mode.js";
import { placeCommand, SANDBOX_NAME } from "./control.ts";
import { findExecutable, scopeLaunch, utcStamp } from "./scope.ts";
import type { SessionCfg } from "./registry.ts";

export const START_HARNESSES = HARNESSES;
const START_PLACES = ["folder", "worktree", "openshell"];
// Harnesses the runner can start in its own per-project OpenShell sandbox (runner/adapters/*.mjs capabilities.places).
const RUNNER_SANDBOX_HARNESSES = ["cursor"];
const GIT_TIMEOUT_MS = 30_000;
export const PROMPT_MAX_CHARS = 4000;
const ID_WAIT_MS = 15_000;
const ID_POLL_MS = 200;
const LOG_READ_MAX = 64 * 1024;
const LOG_END_MAX = 256 * 1024;
const UUID_IN_TEXT = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** Why a start is refused before spawning: an unknown harness, a mode it lacks, or a model it cannot pass; "" when fine. */
export function startRefusal(harness: string, mode = "agent", model?: unknown): string {
  if (!LAUNCH_BINARY[harness as Harness]) return "Unknown harness";
  if (!modeFlags(harness, mode)) return `Unknown ${harness} mode`;
  if (model !== undefined && !modelShape(harness, model)) return "Unknown harness or model";
  return "";
}

/**
 * Fixed argv per harness: [file, args]; worktree names Claude's own --worktree; model must pass modelShape.
 * The mode comes from the new-agent dialogue's Agent / Ask / Plan pill: its flags are the harness's own read-only
 * switches (web/lib/start-mode.js), so "agent" adds nothing and a mode the harness lacks returns null.
 */
export function startCommand(harness: string, root: string, prompt: string, { worktree = "", model, mode, permission, codeMode, requireRunCode = false }: {
  worktree?: string; model?: string; mode?: string; permission?: string; codeMode?: boolean; requireRunCode?: boolean;
} = {}): Command | null {
  return argv(harness as Harness, "start", { root, prompt, worktree, model, mode, permission, codeMode, requireRunCode } as never);
}

/**
 * The --permission-mode a start of this harness passes: a named setting (a team's or an instance's) replaces the
 * configured one. Claude only; {flag: undefined} passes nothing, {error} refuses the start. "auto-afk" is default while
 * AFK is on or quiet. bypassPermissions runs only in OpenShell (sandboxed) or with AI_COLLAB_ALLOW_HOST_AGENT=1.
 */
export function claudePermissionFor(harness: string, cfg: SessionCfg, env: NodeJS.ProcessEnv = process.env, { sandboxed = false, setting: named }: { sandboxed?: boolean; setting?: string } = {}): { flag?: string; error?: string } {
  if (harness !== "claude") return {};
  let mode = named;
  if (named === undefined) {
    const configured = claudePermissionSetting(env) as { mode?: string; error?: string };
    if (configured.error) return { error: configured.error };
    mode = configured.mode;
  } else if (claudePermissionError(named)) {
    return { error: claudePermissionError(named) };
  }
  const flag = claudePermissionFlag(mode as string, ["on", "quiet"].includes((recordedMode(cfg) as { mode?: string } | null)?.mode as string));
  if (flag === "bypassPermissions" && !sandboxed && env[ALLOW_HOST_AGENT_ENV] !== "1") {
    return { flag: undefined, error: `bypassPermissions runs only in openshell; set ${ALLOW_HOST_AGENT_ENV}=1 to allow it on the host` };
  }
  return { flag };
}

/** Maps a startCommand's cursor binary onto this machine's name: `agent` when installed, else `cursor-agent`. */
export function resolveStartBinary(harness: string, cmd: Command | null, path = ""): Command | null {
  if (!cmd) return cmd;
  if (harness !== "cursor") return cmd;
  return [cursorCommandFor({ path }), cmd[1]];
}

/** The child's environment: no AI_COLLAB_* settings, the usual install dirs on PATH, and marked as not the operator typing. */
export function childEnv(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("AI_COLLAB_")));
  // The caller's PATH wins; the install dirs only fill in for a service started with a bare PATH.
  out.PATH = childPath(env, execPath);
  out[WAKE_ENV] = "1"; // the phone prompt is not the operator at a terminal, so it must not turn AFK off
  return out;
}

/** Harnesses this project may start: configured as a peer (or no peer list) and installed. */
export function availableHarnesses(cfg: SessionCfg, env: NodeJS.ProcessEnv = process.env): Harness[] {
  const { PATH } = childEnv(env);
  return START_HARNESSES.filter((h) => (!cfg.peers.length || cfg.peers.includes(h))
    && (h === "cursor" ? CURSOR_BINARIES.some((name) => findExecutable(name, PATH as string)) : findExecutable(LAUNCH_BINARY[h], PATH as string)));
}

/** The sandbox from AI_COLLAB_OPENSHELL_SANDBOX, the runner wake uses, or null. */
export function openshellRunner(env: NodeJS.ProcessEnv = process.env): { kind: string; sandbox: string } | null {
  const sandbox = env.AI_COLLAB_OPENSHELL_SANDBOX || "";
  return SANDBOX_NAME.test(sandbox) ? { kind: "openshell", sandbox } : null;
}

/** Whether the runner can take an OpenShell start: openshell installed and the runner's control socket present. */
function runnerSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(findExecutable("openshell", childEnv(env).PATH as string) && existsSync(runnerSocket(env)));
}

/** Harnesses an openshell start may name: any, in the AI_COLLAB_OPENSHELL_SANDBOX sandbox; else the runner's sandbox harnesses. */
export function openshellHarnesses(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return openshellRunner(env) ? START_HARNESSES : RUNNER_SANDBOX_HARNESSES;
}

/** The registered root folder of a project name; throws when it is not in projects.json or is not a directory. */
export function projectRoot(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const entry = listProjects(env).find((p) => p.project === name);
  if (!entry) throw Object.assign(new Error("Project is not registered in projects.json"), { status: 400 });
  try {
    if (statSync(entry.root).isDirectory()) return entry.root;
  } catch { /* missing */ }
  throw Object.assign(new Error("The project folder is unavailable"), { status: 400 });
}

/** Where this project can start a session: its folder, a new git worktree (git repo and git installed), an openshell sandbox. */
export function availablePlaces(cfg: SessionCfg, env: NodeJS.ProcessEnv = process.env): string[] {
  const { PATH } = childEnv(env);
  const places = ["folder"];
  let root = "";
  try { root = projectRoot(cfg.project, env); } catch { return places; }
  if (existsSync(join(root, ".git")) && findExecutable("git", PATH as string)) places.push("worktree");
  if ((openshellRunner(env) && findExecutable("openshell", PATH as string)) || (existsSync(join(root, ".git")) && runnerSandbox(env))) places.push("openshell");
  return places;
}

/** The place a start gets when it names none: defaults.json startPlace when offered and this harness can run there, else folder. */
export function defaultStartPlace(places: string[], harness: string, env: NodeJS.ProcessEnv = process.env): string {
  const preferred = startPlaceSetting(env);
  if (!places.includes(preferred)) return "folder";
  if (preferred === "openshell" && !openshellHarnesses(env).includes(harness)) return "folder";
  return preferred;
}

// Worktree name and branch for one start: ai-collab-<harness>-<UTC stamp> on branch ai-collab/<harness>-<stamp>.
export function worktreeNames(harness: string, at: number): { name: string; branch: string } {
  const stamp = utcStamp(at);
  return { name: `ai-collab-${harness}-${stamp}`, branch: `ai-collab/${harness}-${stamp}` };
}

// Runs git with a fixed argv and no shell; resolves its exit code.
function runGit(file: string, args: string[], options: SpawnOptions): Promise<number> {
  return new Promise((resolve) => {
    execFile(file, args, { ...options, shell: false, timeout: GIT_TIMEOUT_MS }, (error) => resolve(error ? ((error as NodeJS.ErrnoException).code as unknown as number) ?? 1 : 0));
  });
}

/** The folder a start runs in: the root, or the origin folder inside it if it still exists; a missing origin is refused. */
export function startFolder(root: string, origin = ""): { cwd: string; error?: undefined } | { error: string; cwd?: undefined } {
  if (!origin) return { cwd: root };
  const folder = resolve(origin);
  if (folder !== root && !folder.startsWith(root + sep)) return { error: `The original folder is outside the project: ${folder}` };
  try {
    if (statSync(folder).isDirectory()) return { cwd: folder };
  } catch { /* gone */ }
  return { error: `The original folder is gone: ${folder}; start the session by hand` };
}

/** The prompt trimmed, or an error message: 1-4000 characters, no NUL, and no leading "-" that a CLI could read as a flag. */
export function checkPrompt(prompt: unknown): { text: string; error?: undefined } | { error: string; text?: undefined } {
  if (typeof prompt !== "string" || !prompt.trim() || prompt.trim().length > PROMPT_MAX_CHARS) return { error: "Enter a first prompt of 1–4000 characters" };
  const text = prompt.trim();
  if (text.includes("\0")) return { error: "The prompt contains a NUL character" };
  if (text.startsWith("-")) return { error: "The prompt cannot start with \"-\"" };
  return { text };
}

/** Session or thread id in a harness's first output; "" when none is printed yet. */
export function outputId(harness: string, text: string): string {
  for (const line of text.split("\n")) {
    if (harness === "claude") {
      const id = UUID_IN_TEXT.exec(line)?.[0];
      if (id) return id;
      continue;
    }
    let event: Record<string, unknown> | undefined;
    try { event = JSON.parse(line); } catch { continue; }
    const id = harness === "codex" ? event?.thread_id : harness === "opencode" ? event?.sessionID : event?.session_id;
    if (typeof id === "string" && id && id.length <= 128) return id;
  }
  return "";
}

// The whole log of a short session; "" past the cap, since a long session is not on its first turn.
function readWhole(file: string): string {
  try {
    return statSync(file).size <= LOG_END_MAX ? readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
}

function readHead(file: string): string {
  try {
    const fd = openSync(file, "r");
    try {
      const data = Buffer.alloc(LOG_READ_MAX);
      return data.subarray(0, readSync(fd, data)).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** Spawns the harness detached with its log file, waits up to waitMs for its session id, and reports onEnd at exit. */
export async function startSession(cfg: SessionCfg, { harness = "", prompt = "", model, mode = "agent", place = "folder", origin = "", codeMode, requireRunCode = false, system = false, claudePermission, env = process.env, run: spawnChild = spawn, git = runGit, now = Date.now, waitMs = ID_WAIT_MS, onEnd }: {
  harness?: string; prompt?: string; model?: string; mode?: string; place?: string; origin?: string; codeMode?: unknown; requireRunCode?: boolean; system?: boolean; claudePermission?: string;
  env?: NodeJS.ProcessEnv; run?: typeof spawn; git?: typeof runGit; now?: () => number; waitMs?: number;
  onEnd?: (end: { code: number | null; signal: string | null; log: string }) => unknown;
} = {}): Promise<{ status: string; detail: string; log?: string; session?: string }> {
  if (isProjectPaused(cfg)) return { status: "failed", detail: PROJECT_PAUSED };
  const root = projectRoot(cfg.project, env);
  if (!START_PLACES.includes(place)) return { status: "failed", detail: "Unknown start place" };
  const refused = startRefusal(harness, mode, model);
  if (refused) return { status: "failed", detail: refused };
  const permission = claudePermissionFor(harness, cfg, env, { sandboxed: place === "openshell", setting: claudePermission });
  if (permission.error) return { status: "failed", detail: permission.error };
  const childVars = childEnv(env);
  if (system) childVars[SYSTEM_PROMPT_ENV] = "1";
  if (requireRunCode) childVars[REQUIRE_RUN_CODE_ENV] = "1";
  const tree = place === "worktree" ? worktreeNames(harness, now()) : null;
  const folder = startFolder(root, origin);
  if (folder.error) return { status: "failed", detail: folder.error };
  let cwd = folder.cwd as string;
  // Claude makes its own worktree (--worktree); other harnesses start in one git creates under .claude/worktrees/.
  if (tree && harness !== "claude" && START_HARNESSES.includes(harness as Harness)) {
    const gitFile = findExecutable("git", childVars.PATH as string);
    if (!gitFile) return { status: "failed", detail: "git is not installed" };
    cwd = join(root, ".claude", "worktrees", tree.name);
    const code = await git(gitFile, ["-C", root, "worktree", "add", "-b", tree.branch, cwd], { cwd: root, env: childVars });
    if (code !== 0) return { status: "failed", detail: `git worktree add exited ${code}` };
  }
  const base = startCommand(harness, cwd, prompt, { worktree: tree && harness === "claude" ? tree.name : "", model, mode, permission: permission.flag, requireRunCode, codeMode: resolveCodeMode(codeMode as never, env) });
  if (!base) return { status: "failed", detail: startRefusal(harness, mode, model) || "Unknown harness" };
  const sandbox = place === "openshell" ? openshellRunner(env) : null;
  if (place === "openshell" && !sandbox) return { status: "failed", detail: "AI_COLLAB_OPENSHELL_SANDBOX is not set" };
  const cmd = resolveStartBinary(harness, base, childVars.PATH);
  const refusal = hostAgentRefusal(cmd as Command, { sandboxed: Boolean(sandbox), env });
  if (refusal) return { status: "failed", detail: refusal };
  const command = sandbox ? placeCommand(cmd as Command, cwd, sandbox) : cmd as Command;
  const file = findExecutable(command[0], childVars.PATH as string);
  if (!file) return { status: "failed", detail: `${command[0]} is not installed` };
  const dir = join(cfg.stateDir, cfg.project, "starts");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = join(dir, `${new Date(now()).toISOString().replace(/[:.]/g, "-")}-${harness}.log`);
  // A scope keeps the session alive across a UI or runner restart; the harness still gets the log file as its stdio.
  const launch = scopeLaunch([file, ...command[1]], {
    env, path: childVars.PATH, kind: "session", label: harness, description: `AI Collab ${harness} session`,
  });
  const fd = openSync(log, "a", 0o600);
  let child: ChildProcess;
  try {
    child = spawnChild(launch.file, launch.args, { cwd, env: childVars, detached: true, shell: false, stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd);
  }
  const where = tree ? `${basename(root)}, worktree ${tree.name}` : sandbox ? `${basename(root)}, openshell ${sandbox.sandbox}` : basename(root);
  let exit: { code: number | null; signal: string | null } | null = null;
  const failed = new Promise<{ status: string; detail: string }>((resolve) => {
    child.once("error", (error: NodeJS.ErrnoException) => resolve({ status: "failed", detail: error.code === "ENOENT" ? `${command[0]} is not installed` : `${command[0]} could not start` }));
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      // The caller learns how the session ended from its log; a callback that throws never reaches the process.
      if (typeof onEnd === "function") {
        try { void Promise.resolve(onEnd({ code, signal, log: readWhole(log) })).catch(() => {}); } catch { /* best effort */ }
      }
    });
  });
  child.unref();
  const deadline = now() + waitMs;
  for (;;) {
    const early = await Promise.race([failed, new Promise<null>((r) => setTimeout(r, ID_POLL_MS, null))]);
    if (early) return { ...early, log: basename(log) };
    const id = outputId(harness, readHead(log));
    if (id) {
      return {
        status: "started", detail: `${harness} started in ${where}`, log: basename(log),
        session: `${harness}#${sessionLabel(id)}`,
      };
    }
    const ended = exit as { code: number | null; signal: string | null } | null;
    if (ended && ended.code !== 0) return { status: "failed", detail: `${command[0]} exited ${ended.code ?? ended.signal}; see ${basename(log)}`, log: basename(log) };
    if (ended || now() >= deadline) {
      return { status: "started", detail: `${harness} started in ${where}; no session id printed yet`, log: basename(log) };
    }
  }
}
