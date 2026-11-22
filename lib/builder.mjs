/** `ai-collab builder ...`: start, run, list and stop builder agents, each in its own OpenShell sandbox. See docs/builders.md. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir } from "./config.mjs";
import { cursorBinary, findExecutable, projectRoot } from "./start.mjs";
import { openTasks } from "./tasks.mjs";

const CLI_SCRIPT = fileURLToPath(new URL("../scripts/ai-collab.mjs", import.meta.url));
const HARNESSES = ["cursor", "codex"];
const DEFAULT_MODEL = { cursor: "deepseek-v41-flash-1017-high", codex: "gpt-6.2-sol" };
const UNIT_PREFIX = "builder-";
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BASE_REF = "main";
// openshell 0.1.9 refuses a sandbox name over 19 characters (measured 2026-11-22).
const SANDBOX_PREFIX_MAX = 8;
// runner/ is not in the plugin copy, so runner/sandbox.mjs loads lazily.
const SANDBOX_LIB = "../runner/sandbox.mjs";
const GIT_TIMEOUT_MS = 600_000;
const SYNC_TIMEOUT_MS = 900_000;
// Paths inside the sandbox; everything a builder needs lives under /sandbox, the one writable tree.
const SANDBOX = "/sandbox";
const WORK = "/sandbox/work";
const TOOLS = "/sandbox/tools";
const HOME_IN = "/sandbox/home";
const OUT = "/sandbox/out";
const DEPS = "/sandbox/deps";
const CURSOR_DIR = "/sandbox/agent";
const CODEX_DIR = "/sandbox/codex";
const SANDBOX_PATH = `${TOOLS}/bin:${TOOLS}/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
// API hosts per harness; Cursor's were measured on 2026-11-22, Codex's are UNVERIFIED.
const API_HOSTS = {
  cursor: ["api2.cursor.sh", "api3.cursor.sh", "api4.cursor.sh", "agentn.global.api5.cursor.sh", "cursor.com"],
  codex: ["chatgpt.com", "api.openai.com", "auth.openai.com", "ab.chatgpt.com"],
};
// glibc libraries the sandbox image provides itself; host copies would not match its loader.
const GLIBC_LIB = /^(libc|libm|libdl|libpthread|librt|ld-linux[^.]*)\.so/;
const NTFY_HOST = "host.openshell.internal";
const NTFY_PORT = 8794;
// Host hook events that feed `oncebitten capture` when the host config names none.
const CAPTURE_EVENTS = { cursor: ["beforeSubmitPrompt", "postToolUse", "postToolUseFailure"], codex: ["UserPromptSubmit"] };
const FINAL_PHASES = ["finished", "failed", "stopped"];
const LIVE_STATES = ["active", "activating", "deactivating", "reloading"];
const USAGE = {
  start: "usage: builder start --task <id> --harness cursor|codex [--model M] --brief <file> [--branch B]",
  run: "usage: builder run <id>",
  list: "usage: builder list [--all]",
  stop: "usage: builder stop <id>",
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

/** Argv that runs the harness inside the sandbox; the outer sandbox is the isolation, so the harness's own is off. */
export function harnessCommand({ harness, model, brief, workdir }) {
  if (harness === "cursor") return ["cursor-agent", "-p", "--force", "--trust", "--sandbox", "disabled", "--model", model, brief];
  if (harness === "codex") return ["codex", "exec", "-m", model, "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-C", workdir, brief];
  throw new Error(`unknown harness ${harness}`);
}

/** The sandbox policy (JSON is YAML): the harness's API hosts and the host's ntfy port, for the named binaries only. */
export function builderPolicy({ harness, binaries, ntfyBinaries = [] }) {
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
      [harness]: { name: harness, endpoints: API_HOSTS[harness].map((h) => endpoint(h, 443)), binaries: binaries.map((path) => ({ path })) },
      ai_collab: { name: "ai-collab", endpoints: [endpoint(NTFY_HOST, NTFY_PORT)], binaries: [...binaries, ...ntfyBinaries].map((path) => ({ path })) },
    },
  };
}

/** Hook settings that save every capture payload in the sandbox: Cursor's hooks.json or Codex's. */
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

// runner/sandbox.mjs, loaded by builder() before any command runs.
let S;

export async function builder([sub, ...rest], { env, cfg, out, err }) {
  S ??= await import(SANDBOX_LIB);
  const fail = (key) => { err.write(`ai-collab: ${USAGE[key]}\n`); return 1; };
  try {
    if (sub === "start") return await startBuilder(rest, { env, cfg, out, err, fail });
    if (sub === "run") return rest.length === 1 ? await runBuilder(rest[0], { env, cfg, out, err }) : fail("run");
    if (sub === "list") return await listBuilders(rest, { env, out, fail });
    if (sub === "stop") return rest.length === 1 ? await stopBuilder(rest[0], { env, out, err }) : fail("stop");
  } catch (error) {
    err.write(`ai-collab: builder ${sub}: ${error.message}\n`);
    return 1;
  }
  err.write(`ai-collab: ${Object.values(USAGE).join("\n  ")}\n`);
  return 1;
}

function parseStart(argv) {
  const spec = ["--task", "--harness", "--model", "--brief", "--branch"];
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

async function startBuilder(argv, { env, cfg, out, err, fail }) {
  const flags = parseStart(argv);
  if (!flags || !flags.task || !flags.brief || !HARNESSES.includes(flags.harness)) return fail("start");
  if (!cfg.project) throw new Error("AI_COLLAB_PROJECT is not set and no project matches this folder");
  const task = openTasks(cfg.project, env).list().find((t) => t.id === flags.task);
  if (!task) throw new Error(`no task ${flags.task} in project ${cfg.project}`);
  const id = builderId(flags.task);
  if (!ID_RE.test(id)) throw new Error(`task id ${flags.task} gives no usable builder id`);
  const paths = builderPaths(id, env);
  const brief = readFileSync(flags.brief, "utf8").trim();
  if (!brief) throw new Error(`brief ${flags.brief} is empty`);
  const branch = flags.branch || `builder/${id}`;
  const model = flags.model || DEFAULT_MODEL[flags.harness];
  if (existsSync(paths.worktree)) throw new Error(`worktree ${paths.worktree} already exists`);
  if (LIVE_STATES.includes(await unitState(paths.unit, env))) throw new Error(`unit ${paths.unit} is already running`);
  const root = projectRoot(cfg.project, env);
  await git(root, ["worktree", "add", "--quiet", paths.worktree, "-b", branch, BASE_REF], env);
  const nodeModules = join(root, "node_modules");
  if (existsSync(nodeModules)) symlinkSync(nodeModules, join(paths.worktree, "node_modules"));
  const base = (await git(root, ["rev-parse", BASE_REF], env)).trim();
  rmSync(paths.dir, { recursive: true, force: true });
  mkdirSync(paths.dir, { recursive: true });
  const workdir = `${WORK}/${basename(paths.worktree)}`;
  writeFileSync(paths.brief, `${brief}\n${briefNotes({ task: task.id, branch, workdir })}`);
  writeState(paths, {
    id, task: task.id, project: cfg.project, harness: flags.harness, model, branch, base, root,
    worktree: paths.worktree, unit: paths.unit, sandbox: paths.sandbox, phase: "starting", started: Date.now(),
  });
  if (task.status !== "building") await taskCli(["task", "set", task.id, "status=building"], env);
  const started = await S.runTool(env.AI_COLLAB_SYSTEMD_RUN_BIN || "systemd-run", unitArgv(paths, cfg.project, env), { env, timeoutMs: GIT_TIMEOUT_MS });
  if (started.code !== 0) {
    updateState(paths, { phase: "failed", error: `systemd-run: ${(started.stderr || "").trim()}` });
    throw new Error(`systemd-run failed: ${(started.stderr || "").trim() || `exit ${started.code}`}`);
  }
  out.write(`${paths.unit}\t${task.id}\t${paths.sandbox}\t${paths.worktree}\t${branch}\n`);
  return 0;
}

// systemd-run argv: a transient user unit, so a UI or runner restart cannot kill the builder.
function unitArgv(paths, project, env) {
  const pass = Object.entries(env).filter(([k]) => k === "PATH" || k === "HOME" || k.startsWith("AI_COLLAB_") || k.startsWith("XDG_") || k === "CODEX_HOME");
  const setenv = [...pass.filter(([k]) => k !== "AI_COLLAB_PROJECT"), ["AI_COLLAB_PROJECT", project]].map(([k, v]) => `--setenv=${k}=${v}`);
  return [
    "--user", "--collect", "--quiet", `--unit=${paths.unit}`, `--working-directory=${paths.worktree}`,
    `--description=ai-collab builder ${basename(paths.dir)} (sandboxed)`, ...setenv,
    process.execPath, CLI_SCRIPT, "builder", "run", basename(paths.dir),
  ];
}

// The supervisor inside the unit: sandbox, run, copy back, commit, task status, cleanup.
async function runBuilder(id, { env, out, err }) {
  const paths = builderPaths(id, env);
  const state = readState(paths);
  const log = (line) => out.write(`builder ${id}: ${line}\n`);
  const openshell = env.AI_COLLAB_OPENSHELL_BIN || "openshell";
  let child = null;
  let stopping = false;
  const onTerm = async () => {
    stopping = true;
    if (child) child.kill("SIGTERM");
    await S.destroySandbox({ openshell, env, name: state.sandbox });
    updateState(paths, { phase: "stopped", ended: Date.now() });
    process.exit(143);
  };
  process.once("SIGTERM", onTerm);
  let exitCode = null;
  let created = false;
  try {
    updateState(paths, { phase: "staging", pid: process.pid });
    const staged = await stage(state, paths, { env, log });
    await createSandbox({ openshell, env, name: state.sandbox, policy: paths.policy });
    created = true;
    updateState(paths, { phase: "uploading" });
    await upload(state, paths, staged, { openshell, env, log });
    updateState(paths, { phase: "running" });
    const brief = readFileSync(paths.brief, "utf8");
    const argv = S.execArgv({
      openshell, sandbox: state.sandbox, workdir: staged.workdir, env: staged.execEnv,
      command: harnessCommand({ harness: state.harness, model: state.model, brief, workdir: staged.workdir }),
    });
    log(`running ${state.harness} ${state.model} in sandbox ${state.sandbox}`);
    child = spawn(argv[0], argv.slice(1), { env, stdio: ["ignore", "inherit", "inherit"] });
    exitCode = await new Promise((resolve) => {
      child.on("error", (error) => { log(`could not start openshell: ${error.message}`); resolve(null); });
      child.on("exit", (code) => resolve(code));
    });
    child = null;
    if (stopping) return 143;
    log(`agent exited ${exitCode}`);
    updateState(paths, { phase: "collecting", exitCode });
    await collect(state, paths, staged, { openshell, env, log });
    const result = await finish(state, paths, exitCode, { env, log });
    updateState(paths, { phase: "finished", ended: Date.now(), ...result });
    return 0;
  } catch (error) {
    err.write(`builder ${id}: ${error.message}\n`);
    updateState(paths, { phase: "failed", ended: Date.now(), error: error.message, exitCode });
    await taskCli(["task", "set", state.task, "status=blocked", `detail=builder ${state.unit} failed: ${oneLine(error.message)}`], env).catch(() => {});
    return 1;
  } finally {
    process.removeListener("SIGTERM", onTerm);
    if (!stopping && created) {
      const gone = await S.destroySandbox({ openshell, env, name: state.sandbox });
      log(gone.ok ? `sandbox ${state.sandbox} deleted` : `sandbox delete failed: ${gone.detail}`);
      updateState(paths, { sandboxDeleted: gone.ok });
    }
  }
}

// Builds the host-side staging: a self-contained clone, the tools tree, the sandbox home and the policy.
async function stage(state, paths, { env, log }) {
  rmSync(paths.stage, { recursive: true, force: true });
  mkdirSync(paths.stage, { recursive: true });
  const name = basename(state.worktree);
  const clone = join(paths.stage, name);
  // The worktree's .git is a file pointing into the host repo; the sandbox gets a clone with its own .git.
  await git(paths.stage, ["clone", "--quiet", "--no-hardlinks", "--single-branch", "--branch", state.branch, state.root, clone], env);
  await git(clone, ["remote", "remove", "origin"], env);
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
      if (!statSync(lib).isFile()) continue;
      cpSync(lib, join(tools, "lib", basename(lib)), { dereference: true });
    }
  }
  if (src.npm) {
    symlinkSync(`${TOOLS}/node/lib/node_modules/npm/bin/npm-cli.js`, join(tools, "bin", "npm"));
    symlinkSync(`${TOOLS}/node/lib/node_modules/npm/bin/npx-cli.js`, join(tools, "bin", "npx"));
  }
  const harnessTree = state.harness === "cursor" ? src.cursorTree : src.codexTree;
  if (!harnessTree) throw new Error(`no ${state.harness} install tree found on the host`);
  const harnessDir = state.harness === "cursor" ? CURSOR_DIR : CODEX_DIR;
  const inTree = `${harnessDir}/${basename(harnessTree)}`;
  const launcher = state.harness === "cursor" ? `${inTree}/cursor-agent` : `${inTree}/bin/codex`;
  symlinkSync(launcher, join(tools, "bin", state.harness === "cursor" ? "cursor-agent" : "codex"));
  const home = join(paths.stage, "home");
  const hookDir = join(home, state.harness === "cursor" ? ".cursor" : ".codex");
  mkdirSync(hookDir, { recursive: true });
  writeFileSync(join(hookDir, "hooks.json"), `${JSON.stringify(captureHooks(state.harness, hostCaptureEvents(state.harness, src.hostHooks)), null, 2)}\n`);
  // Hooks on and the worktree trusted, as the host's own config has them; whether `codex exec` then fires them is UNVERIFIED.
  if (state.harness === "codex") writeFileSync(join(hookDir, "config.toml"), `[features]\nhooks = true\n\n[projects."${WORK}/${name}"]\ntrust_level = "trusted"\n`);
  const binaries = executables(state.harness === "cursor" ? harnessTree : join(harnessTree, "bin")).map((f) => `${state.harness === "cursor" ? inTree : `${inTree}/bin`}/${f}`);
  const ntfyBinaries = src.node ? [`${TOOLS}/node/bin/node`] : [];
  writeFileSync(paths.policy, `${JSON.stringify(builderPolicy({ harness: state.harness, binaries, ntfyBinaries }), null, 2)}\n`);
  const workdir = `${WORK}/${name}`;
  // No SSL_CERT_FILE: the login shell points it at the CA that OpenShell terminates TLS with.
  const execEnv = {
    HOME: HOME_IN, XDG_CONFIG_HOME: `${HOME_IN}/.config`, CODEX_HOME: `${HOME_IN}/.codex`, PATH: SANDBOX_PATH, TMPDIR: "/tmp",
    AI_COLLAB_BUILDER_OUT: OUT, AI_COLLAB_BUILDER_TASKS: `${TOOLS}/tasks`, AI_COLLAB_BUILDER: state.id,
    ...(src.gitCore ? { GIT_EXEC_PATH: `${TOOLS}/git-core` } : {}),
    ...(libs.length ? { LD_LIBRARY_PATH: `${TOOLS}/lib` } : {}),
  };
  return { clone, tools, home, src, harnessTree, harnessDir, workdir, execEnv };
}

// Host sources of what the sandbox needs; an AI_COLLAB_BUILDER_* override of "none" leaves one out.
function toolSources(state, env) {
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
  return {
    git: pick("AI_COLLAB_BUILDER_GIT", () => real(findExecutable("git", path))),
    gitCore: pick("AI_COLLAB_BUILDER_GIT_CORE", () => (existsSync("/usr/lib/git-core") ? "/usr/lib/git-core" : "")),
    oncebitten: pick("AI_COLLAB_BUILDER_ONCEBITTEN", () => real(findExecutable("oncebitten", path))),
    node, npm: node && existsSync(npm) ? npm : "",
    nodeModules: pick("AI_COLLAB_BUILDER_NODE_MODULES", () => (existsSync(join(state.root, "node_modules")) ? real(join(state.root, "node_modules")) : "")),
    cursorTree: pick("AI_COLLAB_CURSOR_TREE", () => { const r = real(cursorBin); return r && existsSync(join(dirname(r), "node")) ? dirname(r) : ""; }),
    codexTree: pick("AI_COLLAB_CODEX_TREE", () => { const r = real(codexBin); return r ? dirname(dirname(r)) : ""; }),
    cursorAuth: [join(configHome, "cursor", "auth.json"), join(home, ".cursor", "auth.json")].find((p) => existsSync(p)) || "",
    codexAuth: existsSync(join(codexHome, "auth.json")) ? join(codexHome, "auth.json") : "",
    hostHooks: state.harness === "cursor" ? join(home, ".cursor", "hooks.json") : join(codexHome, "hooks.json"),
  };
}

// Regular executable files directly in a directory: the binaries a network policy names.
function executables(dir) {
  try {
    return readdirSync(dir).filter((f) => { const s = statSync(join(dir, f)); return s.isFile() && (s.mode & 0o111) !== 0; });
  } catch { return []; }
}

/** The shared libraries `ldd` resolves for a binary, minus glibc's own, which must match the image's loader. */
export async function sharedLibs(bin, env = process.env) {
  S ??= await import(SANDBOX_LIB);
  const res = await S.runTool("ldd", [bin], { env });
  if (res.code !== 0) return [];
  return [...res.stdout.matchAll(/=>\s+(\/\S+)/g)].map((m) => m[1]).filter((p) => {
    if (GLIBC_LIB.test(basename(p))) return false;
    try {
      return statSync(p).isFile();
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

async function must(bin, args, env, what) {
  const res = await S.runTool(bin, args, { env, timeoutMs: SYNC_TIMEOUT_MS });
  if (res.code !== 0) throw new Error(`openshell ${what} failed: ${(res.stderr || "").trim() || `exit ${res.code}`}`);
  return res;
}

// Uploads a directory unfiltered: .gitignore filtering would drop the clone's .git and every dependency.
async function uploadAll({ openshell, env, sandbox, local, remote }) {
  return must(openshell, ["sandbox", "upload", sandbox, `${local.replace(/\/+$/, "")}/`, `${remote.replace(/\/+$/, "")}/`, "--no-git-ignore"], env, "sandbox upload");
}

async function upload(state, paths, staged, { openshell, env, log }) {
  const sandbox = state.sandbox;
  const { src } = staged;
  await uploadAll({ openshell, env, sandbox, local: staged.clone, remote: WORK });
  await uploadAll({ openshell, env, sandbox, local: staged.tools, remote: SANDBOX });
  await uploadAll({ openshell, env, sandbox, local: staged.home, remote: SANDBOX });
  if (src.gitCore) await uploadAll({ openshell, env, sandbox, local: src.gitCore, remote: TOOLS });
  if (src.node) await S.uploadFile({ openshell, env, sandbox, local: src.node, remoteDir: `${TOOLS}/node/bin` });
  if (src.npm) await uploadAll({ openshell, env, sandbox, local: src.npm, remote: `${TOOLS}/node/lib/node_modules` });
  await uploadAll({ openshell, env, sandbox, local: staged.harnessTree, remote: staged.harnessDir });
  const auth = state.harness === "cursor" ? src.cursorAuth : src.codexAuth;
  const authDir = state.harness === "cursor" ? `${HOME_IN}/.config/cursor` : `${HOME_IN}/.codex`;
  if (auth) await uploadSecret({ openshell, env, sandbox, file: auth, remoteDir: authDir });
  else log(`no host ${state.harness} auth.json; the harness will ask to log in`);
  if (src.nodeModules) {
    await uploadAll({ openshell, env, sandbox, local: src.nodeModules, remote: DEPS });
    await must(openshell, S.execArgv({ openshell, sandbox, command: ["ln", "-sfn", `${DEPS}/${basename(src.nodeModules)}`, `${staged.workdir}/node_modules`] }).slice(1), env, "sandbox exec ln");
  }
}

// Copies a credential through a 0600 temp file so it never appears in argv, env or a log.
async function uploadSecret({ openshell, env, sandbox, file, remoteDir }) {
  const dir = mkdtempSync(join(tmpdir(), "ai-collab-builder-auth-"));
  try {
    const copy = join(dir, basename(file));
    writeFileSync(copy, readFileSync(file), { mode: 0o600 });
    await S.uploadFile({ openshell, env, sandbox, local: copy, remoteDir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Downloads the worktree clone and the recorded hook payloads and task calls.
async function collect(state, paths, staged, { openshell, env, log }) {
  await S.runTool(openshell, S.execArgv({ openshell, sandbox: state.sandbox, command: ["rm", "-f", `${staged.workdir}/node_modules`] }).slice(1), { env });
  rmSync(paths.back, { recursive: true, force: true });
  rmSync(paths.out, { recursive: true, force: true });
  mkdirSync(paths.back, { recursive: true });
  await must(openshell, ["sandbox", "download", state.sandbox, staged.workdir, join(paths.back, basename(staged.workdir))], env, "sandbox download");
  const got = await S.runTool(openshell, ["sandbox", "download", state.sandbox, OUT, paths.out], { env, timeoutMs: SYNC_TIMEOUT_MS });
  if (got.code !== 0) log("no recorded task calls or hook payloads");
}

// Lands the commits on the host branch, replays captures and task calls, checks oncebitten, settles the status.
async function finish(state, paths, exitCode, { env, log }) {
  const back = join(paths.back, basename(state.worktree));
  if ((await git(back, ["status", "--porcelain"], env)).trim()) {
    await git(back, ["add", "-A"], env);
    await git(back, ["commit", "--quiet", "--no-verify", "-m", `chore(builder): uncommitted work from ${state.id}`, "-m", `Assisted-by: ${state.harness === "cursor" ? "Cursor" : "Codex"}:${state.model}`], env);
    log("committed the agent's uncommitted changes on the host");
  }
  const commits = Number((await git(back, ["rev-list", "--count", `${state.base}..HEAD`], env)).trim()) || 0;
  let landed = false;
  let landError = "";
  if (commits > 0) {
    try {
      await git(state.worktree, ["fetch", "--quiet", back, "HEAD"], env);
      await git(state.worktree, ["merge", "--quiet", "--ff-only", "FETCH_HEAD"], env);
      landed = true;
      log(`${commits} commit(s) on ${state.branch}`);
    } catch (error) {
      landError = `could not fast-forward ${state.branch}; the work is kept in ${back}: ${oneLine(error.message)}`;
      log(landError);
    }
  }
  const captured = await replayCaptures(state, paths, env, log);
  const calls = await replayCalls(state, paths, env, log);
  const check = landed ? await oncebittenCheck(state, env) : { code: null, text: "" };
  if (check.code === 1) log(`oncebitten check fired: ${check.text}`);
  const own = calls.lastStatus;
  let status = own;
  let detail = "";
  if (landError) { status = "blocked"; detail = landError; }
  else if (check.code === 1 && own !== "blocked") { status = "blocked"; detail = `oncebitten check --base ${BASE_REF} fired: ${check.text}`; }
  else if (!own && exitCode === 0 && landed) status = "done";
  else if (!own) { status = "blocked"; detail = `builder ${state.unit} exited ${exitCode} with ${commits} commit(s) and set no status`; }
  if (status !== own || detail) await taskCli(["task", "set", state.task, `status=${status}`, ...(detail ? [`detail=${oneLine(detail)}`] : [])], env);
  await taskCli(["task", "progress", state.task, `builder ${state.unit}: exit ${exitCode}, ${commits} commit(s) on ${state.branch}, ${captured} oncebitten capture(s)`], env).catch(() => {});
  if (landed) rmSync(paths.back, { recursive: true, force: true });
  rmSync(paths.stage, { recursive: true, force: true });
  return { commits, landed, status, captured, oncebitten: check.code };
}

// Feeds every saved hook payload to the host's `oncebitten capture`, with sandbox paths mapped to the host worktree.
async function replayCaptures(state, paths, env, log) {
  const dir = join(paths.out, "oncebitten");
  if (!existsSync(dir)) return 0;
  const bin = env.AI_COLLAB_ONCEBITTEN_BIN || findExecutable("oncebitten", env.PATH || "");
  if (!bin) { log("oncebitten is not installed on the host; captures dropped"); return 0; }
  const workdir = `${WORK}/${basename(state.worktree)}`;
  let count = 0;
  for (const file of readdirSync(dir).sort()) {
    const host = file.replace(/\.json$/, "").split("-").slice(2).join("-") || state.harness;
    const payload = readFileSync(join(dir, file), "utf8").split(workdir).join(state.worktree);
    if (!payload.trim()) continue;
    const res = await S.runTool(bin, ["capture", "--host", HARNESSES.includes(host) ? host : state.harness], { env, cwd: state.worktree, stdin: payload });
    if (res.code === 0) count += 1;
  }
  return count;
}

// Applies the agent's recorded `task set` and `task progress` calls on the host; returns the last status it set on its own task.
async function replayCalls(state, paths, env, log) {
  const dir = join(paths.out, "ai-collab");
  let lastStatus = "";
  if (!existsSync(dir)) return { lastStatus };
  for (const file of readdirSync(dir).sort()) {
    const argv = parseRecordedCall(readFileSync(join(dir, file), "utf8"));
    if (!replayable(argv)) { log(`skipped recorded call: ${argv.slice(0, 2).join(" ")}`); continue; }
    const code = await taskCli(argv, env).then(() => 0, (error) => { log(`recorded call failed: ${error.message}`); return 1; });
    const status = argv.slice(3).find((a) => a.startsWith("status="));
    if (code === 0 && argv[1] === "set" && argv[2] === state.task && status) lastStatus = status.slice("status=".length);
  }
  return { lastStatus };
}

async function oncebittenCheck(state, env) {
  const bin = env.AI_COLLAB_ONCEBITTEN_BIN || findExecutable("oncebitten", env.PATH || "");
  if (!bin) return { code: 2, text: "oncebitten is not installed" };
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
  const stopped = await S.runTool(env.AI_COLLAB_SYSTEMCTL_BIN || "systemctl", ["--user", "stop", state.unit], { env });
  const gone = await S.destroySandbox({ openshell: env.AI_COLLAB_OPENSHELL_BIN || "openshell", env, name: state.sandbox });
  if (!FINAL_PHASES.includes(readState(paths).phase)) updateState(paths, { phase: "stopped", ended: Date.now() });
  out.write(`${state.unit}\t${stopped.code === 0 ? "stopped" : `stop failed: ${(stopped.stderr || "").trim()}`}\tsandbox ${gone.ok ? "deleted" : "delete failed"}\n`);
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
  mkdirSync(dirname(paths.state), { recursive: true });
  writeFileSync(paths.state, `${JSON.stringify(state, null, 2)}\n`);
}

function updateState(paths, patch) {
  let state = {};
  try { state = readState(paths); } catch { /* first write */ }
  writeState(paths, { ...state, ...patch, updated: Date.now() });
}
