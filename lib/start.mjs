/**
 * Starts a new headless, resumable agent session in a folder registered in projects.json, for the operator UI.
 * The argv comes from a fixed template per harness and the prompt is one element; no shell. Codex gets
 * CODEX_HOOK_TRUST and no other trust or permission flag; the other harnesses get no permission-skipping flag.
 * The child gets explicit AI_COLLAB_* launch settings. Its hooks resolve the project from projects.json by cwd.
 */
import { ALLOW_HOST_AGENT_ENV, hostAgentRefusal } from "./agent-guard.mjs";
import { isProjectPaused, PROJECT_PAUSED } from "./project-pause.ts";
import { execFile, spawn } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { claudePermissionSetting, listProjects, sessionLabel, startPlaceSetting } from "./config.mjs";
import { runnerSocket } from "./runner-request.mjs";
import { recordedMode, WAKE_ENV } from "./mode.mjs";
import { SYSTEM_PROMPT_ENV } from "./machine-prompt.mjs";
import { SANDBOX_NAME, placeCommand } from "./controls.mjs";
import { argv, claudePermissionError, claudePermissionFlag, CODEX_HOOK_TRUST, CURSOR_BINARIES, childPath, cursorBinary, cursorCommandFor, HARNESSES, LAUNCH_BINARY, modelShape, MODEL_NAME, OPENCODE_MODEL_NAME } from "./harness.ts";

export { CODEX_HOOK_TRUST, CURSOR_BINARIES, cursorBinary, MODEL_NAME, modelShape, OPENCODE_MODEL_NAME };
import { scopeLaunch } from "./scope.mjs";
import { modeFlags } from "../web/lib/start-mode.js";
import { REQUIRE_RUN_CODE_ENV, resolveCodeMode } from "./code-mode.mjs";

export const START_HARNESSES = HARNESSES;
export const START_PLACES = ["folder", "worktree", "openshell"];
// Harnesses the runner can start in its own per-project OpenShell sandbox (runner/adapters/*.mjs capabilities.places).
// Codex there needs a tracked builder; Claude and OpenCode adapters have no sandbox launcher yet (docs/phone-ui.md).
export const RUNNER_SANDBOX_HARNESSES = ["cursor"];
const GIT_TIMEOUT_MS = 30_000;
export const PROMPT_MAX_CHARS = 4000;
const ID_WAIT_MS = 15_000;
const ID_POLL_MS = 200;
const LOG_READ_MAX = 64 * 1024;
const LOG_END_MAX = 256 * 1024;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** Why a start would be refused before spawning: an unknown harness, a mode it lacks, or a model it cannot pass; "" when fine. */
export function startRefusal(harness, mode = "agent", model) {
  if (!LAUNCH_BINARY[harness]) return "Unknown harness";
  if (!modeFlags(harness, mode)) return `Unknown ${harness} mode`;
  if (model !== undefined && !modelShape(harness, model)) return "Unknown harness or model";
  return "";
}

/**
 * Fixed argv per harness: [file, args]; worktree names Claude's own --worktree; model must pass modelShape.
 * The mode comes from the new-agent dialogue's Agent / Ask / Plan pill: its flags are the harness's own read-only
 * switches (web/lib/start-mode.js), so "agent" adds nothing and a mode the harness lacks returns null.
 * permission is Claude's --permission-mode from claudePermissionFor; a plan mode's own flag takes its place.
 */
export function startCommand(harness, root, prompt, { worktree = "", model, mode, permission, codeMode, requireRunCode = false } = {}) {
  return argv(harness, "start", { root, prompt, worktree, model, mode, permission, codeMode, requireRunCode });
}

/**
 * The --permission-mode a start of this harness passes, from defaults.json claudePermissionMode and whether AFK is on
 * for the project as this machine last recorded it. Claude only; {flag: undefined} passes nothing, {error} refuses the start.
 * A named setting (a team's or an instance's, instead of defaults.json) replaces the configured one.
 * bypassPermissions runs only in OpenShell (sandboxed) or with AI_COLLAB_ALLOW_HOST_AGENT=1, as the runner requires.
 */
export function claudePermissionFor(harness, cfg, env = process.env, { sandboxed = false, setting: named } = {}) {
  if (harness !== "claude") return {};
  let mode = named;
  if (named === undefined) {
    const configured = claudePermissionSetting(env);
    if (configured.error) return configured;
    mode = configured.mode;
  } else if (claudePermissionError(named)) {
    return { error: claudePermissionError(named) };
  }
  const flag = claudePermissionFlag(mode, ["on", "quiet"].includes(recordedMode(cfg)?.mode));
  if (flag === "bypassPermissions" && !sandboxed && env[ALLOW_HOST_AGENT_ENV] !== "1") {
    return { flag: undefined, error: `bypassPermissions runs only in openshell; set ${ALLOW_HOST_AGENT_ENV}=1 to allow it on the host` };
  }
  return { flag };
}

/** Maps a startCommand's cursor binary onto this machine's name: `agent` when installed, else `cursor-agent`. */
export function resolveStartBinary(harness, argv, path = "") {
  if (!argv) return argv;
  if (harness !== "cursor") return argv;
  return [cursorCommandFor({ path }), ...argv.slice(1)];
}

/** The child's environment: no AI_COLLAB_* settings, the usual install dirs on PATH, and marked as not the operator typing. */
export function childEnv(env = process.env, execPath = process.execPath) {
  const out = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("AI_COLLAB_")));
  // The caller's PATH wins; the install dirs only fill in for a service started with a bare PATH.
  out.PATH = childPath(env, execPath);
  out[WAKE_ENV] = "1"; // the phone prompt is not the operator at a terminal, so it must not turn AFK off
  return out;
}

/** Absolute path of an executable on PATH, or "". */
export function findExecutable(name, path = "") {
  for (const dir of path.split(delimiter).filter((d) => isAbsolute(d))) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch { /* next */ }
  }
  return "";
}


/** Harnesses this project may start: configured as a peer (or no peer list) and installed. */
export function availableHarnesses(cfg, env = process.env) {
  const { PATH } = childEnv(env);
  return START_HARNESSES.filter((h) => (!cfg.peers.length || cfg.peers.includes(h))
    && (h === "cursor" ? CURSOR_BINARIES.some((name) => findExecutable(name, PATH)) : findExecutable(LAUNCH_BINARY[h], PATH)));
}

/** The sandbox from AI_COLLAB_OPENSHELL_SANDBOX, the runner wake uses, or null. */
export function openshellRunner(env = process.env) {
  const sandbox = env.AI_COLLAB_OPENSHELL_SANDBOX || "";
  return SANDBOX_NAME.test(sandbox) ? { kind: "openshell", sandbox } : null;
}

/** Whether the runner can take an OpenShell start: openshell installed and the runner's control socket present. */
export function runnerSandbox(env = process.env) {
  return Boolean(findExecutable("openshell", childEnv(env).PATH) && existsSync(runnerSocket(env)));
}

/** Harnesses an openshell start may name: any, in the AI_COLLAB_OPENSHELL_SANDBOX sandbox; else the runner's sandbox harnesses. */
export function openshellHarnesses(env = process.env) {
  return openshellRunner(env) ? START_HARNESSES : RUNNER_SANDBOX_HARNESSES;
}

/** Where this project can start a session: its folder, a new git worktree (git repo and git installed), an openshell sandbox. */
export function availablePlaces(cfg, env = process.env) {
  const { PATH } = childEnv(env);
  const places = ["folder"];
  let root = "";
  try { root = projectRoot(cfg.project, env); } catch { return places; }
  if (existsSync(join(root, ".git")) && findExecutable("git", PATH)) places.push("worktree");
  if ((openshellRunner(env) && findExecutable("openshell", PATH)) || (existsSync(join(root, ".git")) && runnerSandbox(env))) places.push("openshell");
  return places;
}

/** The place a start gets when it names none: defaults.json startPlace when offered and this harness can run there, else folder. */
export function defaultStartPlace(places, harness, env = process.env) {
  const preferred = startPlaceSetting(env);
  if (!places.includes(preferred)) return "folder";
  if (preferred === "openshell" && !openshellHarnesses(env).includes(harness)) return "folder";
  return preferred;
}

// Worktree name and branch for one start: ai-collab-<harness>-<UTC stamp> on branch ai-collab/<harness>-<stamp>.
export function worktreeNames(harness, at) {
  const stamp = new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return { name: `ai-collab-${harness}-${stamp}`, branch: `ai-collab/${harness}-${stamp}` };
}

// Runs git with a fixed argv and no shell; resolves its exit code.
function runGit(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, { ...options, shell: false, timeout: GIT_TIMEOUT_MS }, (error) => resolve(error ? (error.code ?? 1) : 0));
  });
}

/** The folder a start runs in: the project root, or the origin folder (a session's worktree) when it lies inside the root and still exists.
 * Returns {cwd} or {error}; a missing origin is refused, not replaced by the root.
 */
export function startFolder(root, origin = "") {
  if (!origin) return { cwd: root };
  const folder = resolve(origin);
  if (folder !== root && !folder.startsWith(root + sep)) return { error: `The original folder is outside the project: ${folder}` };
  try {
    if (statSync(folder).isDirectory()) return { cwd: folder };
  } catch { /* gone */ }
  return { error: `The original folder is gone: ${folder}; start the session by hand` };
}

/** The registered root folder of a project name; throws when it is not in projects.json or is not a directory. */
export function projectRoot(name, env = process.env) {
  const entry = listProjects(env).find((p) => p.project === name);
  if (!entry) throw Object.assign(new Error("Project is not registered in projects.json"), { status: 400 });
  try {
    if (statSync(entry.root).isDirectory()) return entry.root;
  } catch { /* missing */ }
  throw Object.assign(new Error("The project folder is unavailable"), { status: 400 });
}

/** The prompt trimmed, or an error message: 1-4000 characters, no NUL, and no leading "-" that a CLI could read as a flag. */
export function checkPrompt(prompt) {
  if (typeof prompt !== "string" || !prompt.trim() || prompt.trim().length > PROMPT_MAX_CHARS) return { error: "Enter a first prompt of 1–4000 characters" };
  const text = prompt.trim();
  if (text.includes("\0")) return { error: "The prompt contains a NUL character" };
  if (text.startsWith("-")) return { error: "The prompt cannot start with \"-\"" };
  return { text };
}

/** Session or thread id in a harness's first output; "" when none is printed yet. */
export function outputId(harness, text) {
  for (const line of text.split("\n")) {
    if (harness === "claude") {
      const id = UUID.exec(line)?.[0];
      if (id) return id;
      continue;
    }
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const id = harness === "codex" ? event?.thread_id : harness === "opencode" ? event?.sessionID : event?.session_id;
    if (typeof id === "string" && id && id.length <= 128) return id;
  }
  return "";
}

// The whole log of a short session; "" past the cap, since a long session is not on its first turn.
function readWhole(file) {
  try {
    return statSync(file).size <= LOG_END_MAX ? readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
}

function readHead(file) {
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

/**
 * Spawns the harness detached in the project root with its output in a log file under the state dir, then waits up to
 * waitMs for the session id it prints. Resolves {status:"started"|"failed", detail, session?, log}.
 * onEnd({code, signal, log}) runs when the process exits, with the log text of a short session.
 */
export async function startSession(cfg, { harness, prompt, model, mode = "agent", place = "folder", origin = "", codeMode, requireRunCode = false, system = false, claudePermission, env = process.env, run = spawn, git = runGit, now = Date.now, waitMs = ID_WAIT_MS, onEnd } = {}) {
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
  let cwd = folder.cwd;
  // Claude makes its own worktree (--worktree); other harnesses start in one git creates under .claude/worktrees/.
  if (tree && harness !== "claude" && START_HARNESSES.includes(harness)) {
    const gitFile = findExecutable("git", childVars.PATH);
    if (!gitFile) return { status: "failed", detail: "git is not installed" };
    cwd = join(root, ".claude", "worktrees", tree.name);
    const code = await git(gitFile, ["-C", root, "worktree", "add", "-b", tree.branch, cwd], { cwd: root, env: childVars });
    if (code !== 0) return { status: "failed", detail: `git worktree add exited ${code}` };
  }
  const base = startCommand(harness, cwd, prompt, { worktree: tree && harness === "claude" ? tree.name : "", model, mode, permission: permission.flag, requireRunCode, codeMode: resolveCodeMode(codeMode, env) });
  if (!base) return { status: "failed", detail: startRefusal(harness, mode, model) || "Unknown harness" };
  const sandbox = place === "openshell" ? openshellRunner(env) : null;
  if (place === "openshell" && !sandbox) return { status: "failed", detail: "AI_COLLAB_OPENSHELL_SANDBOX is not set" };
  const argv = resolveStartBinary(harness, base, childVars.PATH);
  const refusal = hostAgentRefusal(argv, { sandboxed: Boolean(sandbox), env });
  if (refusal) return { status: "failed", detail: refusal };
  const command = sandbox ? placeCommand(argv, cwd, sandbox) : argv;
  const file = findExecutable(command[0], childVars.PATH);
  if (!file) return { status: "failed", detail: `${command[0]} is not installed` };
  const dir = join(cfg.stateDir, cfg.project, "starts");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = join(dir, `${new Date(now()).toISOString().replace(/[:.]/g, "-")}-${harness}.log`);
  // A scope keeps the session alive across a UI or runner restart; the harness still gets the log file as its stdio.
  // The decision reads this process's env (AI_COLLAB_SCOPE never reaches the child) and the harness PATH.
  const launch = scopeLaunch([file, ...command[1]], {
    env, path: childVars.PATH, kind: "session", label: harness, now, description: `AI Collab ${harness} session`,
  });
  const fd = openSync(log, "a", 0o600);
  let child;
  try {
    child = run(launch.file, launch.args, { cwd, env: childVars, detached: true, shell: false, stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd);
  }
  const where = tree ? `${basename(root)}, worktree ${tree.name}` : sandbox ? `${basename(root)}, openshell ${sandbox.sandbox}` : basename(root);
  let exit = null;
  const failed = new Promise((resolve) => {
    child.once("error", (error) => resolve({ status: "failed", detail: error.code === "ENOENT" ? `${command[0]} is not installed` : `${command[0]} could not start` }));
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
    const early = await Promise.race([failed, new Promise((r) => setTimeout(r, ID_POLL_MS, null))]);
    if (early) return { ...early, log: basename(log) };
    const id = outputId(harness, readHead(log));
    if (id) {
      return {
        status: "started", detail: `${harness} started in ${where}`, log: basename(log),
        session: `${harness}#${sessionLabel(id)}`,
      };
    }
    if (exit && exit.code !== 0) return { status: "failed", detail: `${command[0]} exited ${exit.code ?? exit.signal}; see ${basename(log)}`, log: basename(log) };
    if (exit || now() >= deadline) {
      return { status: "started", detail: `${harness} started in ${where}; no session id printed yet`, log: basename(log) };
    }
  }
}
