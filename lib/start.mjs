/**
 * Starts a new headless, resumable agent session in a folder registered in projects.json, for the operator UI.
 * The argv comes from a fixed template per harness and the prompt is one element; no shell, no permission-skipping flags.
 * The child gets no AI_COLLAB_* variables: its hooks resolve the project from projects.json by cwd, like any session.
 */
import { execFile, spawn } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { listProjects, sessionLabel } from "./config.mjs";
import { WAKE_ENV } from "./mode.mjs";
import { SANDBOX_NAME, placeCommand } from "./controls.mjs";

export const START_HARNESSES = ["claude", "codex", "cursor", "opencode"];
export const START_PLACES = ["folder", "worktree", "openshell"];
const GIT_TIMEOUT_MS = 30_000;
export const PROMPT_MAX_CHARS = 4000;
const EXECUTABLES = { claude: "claude", codex: "codex", cursor: "cursor-agent", opencode: "opencode" };
const ID_WAIT_MS = 15_000;
const ID_POLL_MS = 200;
const LOG_READ_MAX = 64 * 1024;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
// Codex records persisted trust for each plugin hook under this key prefix in config.toml.
const CODEX_TRUST_KEY = "ai-collab@ai-collab:hooks/codex-hooks.json:session_start:";

// Shape of a model name a start may pass; membership in lib/models.mjs's allowlist is checked by the caller.
export const MODEL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:[\]-]{0,79}$/;
// OpenCode names a model provider/model#variant (`opencode run --help`); the model part may hold more slashes.
export const OPENCODE_MODEL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}\/[a-zA-Z0-9][a-zA-Z0-9._:@/[\]-]{0,119}(#[a-zA-Z0-9._-]{1,40})?$/;

/** Whether a model name has the shape this harness's start may pass. */
export function modelShape(harness, model) {
  return typeof model === "string" && (harness === "opencode" ? OPENCODE_MODEL_NAME : MODEL_NAME).test(model);
}

/** Fixed argv per harness: [file, args]; worktree names Claude's own --worktree; model must pass modelShape (null otherwise). */
export function startCommand(harness, root, prompt, { worktree = "", model } = {}) {
  if (model !== undefined && !modelShape(harness, model)) return null;
  const flag = (name) => (model === undefined ? [] : [name, model]);
  switch (harness) {
    case "claude": return [EXECUTABLES.claude, ["--bg", ...(worktree ? ["--worktree", worktree] : []), ...flag("--model"), prompt]];
    case "codex": return [EXECUTABLES.codex, ["exec", "--json", ...flag("-m"), prompt]];
    case "cursor": return [EXECUTABLES.cursor, ["-p", "--trust", "--output-format", "stream-json", "--workspace", root, ...flag("--model"), prompt]];
    // `opencode run` works in its cwd (the project root or a worktree); --format json prints one event per line.
    case "opencode": return [EXECUTABLES.opencode, ["run", "--format", "json", ...flag("-m"), prompt]];
    default: return null;
  }
}

/** The child's environment: no AI_COLLAB_* settings, the usual install dirs on PATH, and marked as not the operator typing. */
export function childEnv(env = process.env, execPath = process.execPath) {
  const out = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("AI_COLLAB_")));
  // The caller's PATH wins; the install dirs only fill in for a service started with a bare PATH.
  out.PATH = [env.PATH, dirname(execPath), join(env.HOME || homedir(), ".local", "bin")].filter(Boolean).join(delimiter);
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
  return START_HARNESSES.filter((h) => (!cfg.peers.length || cfg.peers.includes(h)) && findExecutable(EXECUTABLES[h], PATH));
}

/** The sandbox from AI_COLLAB_OPENSHELL_SANDBOX, the runner wake uses, or null. */
export function openshellRunner(env = process.env) {
  const sandbox = env.AI_COLLAB_OPENSHELL_SANDBOX || "";
  return SANDBOX_NAME.test(sandbox) ? { kind: "openshell", sandbox } : null;
}

/** Where this project can start a session: its folder, a new git worktree (git repo and git installed), an openshell sandbox. */
export function availablePlaces(cfg, env = process.env) {
  const { PATH } = childEnv(env);
  const places = ["folder"];
  let root = "";
  try { root = projectRoot(cfg.project, env); } catch { return places; }
  if (existsSync(join(root, ".git")) && findExecutable("git", PATH)) places.push("worktree");
  if (openshellRunner(env) && findExecutable("openshell", PATH)) places.push("openshell");
  return places;
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

/**
 * The folder a start runs in: the project root, or the origin folder (a session's worktree) when it lies inside the root and still exists.
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

/** True when Codex has persisted trust for the plugin's hooks, false when not, null when unknown. */
export function codexHooksTrusted(env = process.env) {
  try {
    const config = readFileSync(join(env.CODEX_HOME || join(env.HOME || homedir(), ".codex"), "config.toml"), "utf8");
    const at = config.indexOf(CODEX_TRUST_KEY);
    return at >= 0 && /^\s*trusted_hash\s*=/m.test(config.slice(at, at + 400).split("\n[")[0]);
  } catch {
    return null;
  }
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
 */
export async function startSession(cfg, { harness, prompt, model, place = "folder", origin = "", env = process.env, run = spawn, git = runGit, now = Date.now, waitMs = ID_WAIT_MS } = {}) {
  const root = projectRoot(cfg.project, env);
  if (!START_PLACES.includes(place)) return { status: "failed", detail: "Unknown start place" };
  if (!startCommand(harness, root, prompt, { model })) return { status: "failed", detail: model === undefined ? "Unknown harness" : "Unknown harness or model" };
  const childVars = childEnv(env);
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
  const base = startCommand(harness, cwd, prompt, { worktree: tree && harness === "claude" ? tree.name : "", model });
  if (!base) return { status: "failed", detail: "Unknown harness" };
  const sandbox = place === "openshell" ? openshellRunner(env) : null;
  if (place === "openshell" && !sandbox) return { status: "failed", detail: "AI_COLLAB_OPENSHELL_SANDBOX is not set" };
  const command = sandbox ? placeCommand(base, cwd, sandbox) : base;
  const file = findExecutable(command[0], childVars.PATH);
  if (!file) return { status: "failed", detail: `${command[0]} is not installed` };
  const dir = join(cfg.stateDir, cfg.project, "starts");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = join(dir, `${new Date(now()).toISOString().replace(/[:.]/g, "-")}-${harness}.log`);
  const fd = openSync(log, "a", 0o600);
  let child;
  try {
    child = run(file, command[1], { cwd, env: childVars, detached: true, shell: false, stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd);
  }
  const where = tree ? `${basename(root)}, worktree ${tree.name}` : sandbox ? `${basename(root)}, openshell ${sandbox.sandbox}` : basename(root);
  let exit = null;
  const failed = new Promise((resolve) => {
    child.once("error", (error) => resolve({ status: "failed", detail: error.code === "ENOENT" ? `${command[0]} is not installed` : `${command[0]} could not start` }));
    child.once("exit", (code, signal) => { exit = { code, signal }; });
  });
  child.unref();
  const warning = harness === "codex" && codexHooksTrusted(env) === false
    ? "Codex has not trusted the ai-collab hooks, so this session will not report to AI Collab; trust them in /hooks." : "";
  const deadline = now() + waitMs;
  for (;;) {
    const early = await Promise.race([failed, new Promise((r) => setTimeout(r, ID_POLL_MS, null))]);
    if (early) return { ...early, log: basename(log) };
    const id = outputId(harness, readHead(log));
    if (id) {
      return {
        status: "started", detail: `${harness} started in ${where}`, log: basename(log),
        session: `${harness}#${sessionLabel(id)}`, ...(warning ? { warning } : {}),
      };
    }
    if (exit && exit.code !== 0) return { status: "failed", detail: `${command[0]} exited ${exit.code ?? exit.signal}; see ${basename(log)}`, log: basename(log) };
    if (exit || now() >= deadline) {
      return { status: "started", detail: `${harness} started in ${where}; no session id printed yet`, log: basename(log), ...(warning ? { warning } : {}) };
    }
  }
}
