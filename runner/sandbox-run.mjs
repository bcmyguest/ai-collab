#!/usr/bin/env node
// Runs one agent harness command inside a fresh OpenShell sandbox and lands its commits on the host; schedules.json
// entries with "sandbox": true run through it. Usage: sandbox-run.mjs --name N --cwd DIR [--project P] -- <argv...>
//
// Staging follows lib/builder.mjs: a clone of cwd's branch, node, git, the ai-collab CLI and the harness install go
// in by upload; ntfy is reachable at host.openshell.internal:8794; the clone comes back by download, uncommitted work
// becomes one commit, and new commits land on branch sandbox/<name>-<stamp> in cwd's repository. The sandbox is
// deleted at the end, also after a timeout (SIGTERM from the schedule).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentHarness } from "../lib/agent-guard.mjs";
import { autoDefaults, listProjects, stateDir } from "../lib/config.mjs";
import { builderPolicy, replayable, parseRecordedCall, sharedLibs, toolSources } from "../lib/builder.mjs";
import { projectOfFolder } from "../lib/schedule-session.mjs";
import { destroySandbox, execArgv, runTool, sandboxCapRefusal, uploadFile, uploadLogins } from "./sandbox.mjs";

const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(APP_ROOT, "scripts", "ai-collab.mjs");
const APP_PARTS = ["package.json", "scripts", "lib", "web/lib"];
const SANDBOX = "/sandbox";
const WORK = "/sandbox/work";
const TOOLS = "/sandbox/tools";
const HOME_IN = "/sandbox/home";
const OUT = "/sandbox/out";
const APP_IN = `${TOOLS}/ai-collab`;
const NODE_IN = `${TOOLS}/node/bin/node`;
const TOKEN_IN = `${HOME_IN}/.config/ai-collab/ntfy-token`;
const SANDBOX_PATH = `${TOOLS}/bin:${TOOLS}/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
const NTFY = "http://host.openshell.internal:8794";
const SYNC_TIMEOUT_MS = 900_000;
const NAME_PREFIX_MAX = 8;
// Per harness: where its install goes, the launcher inside it, and where its login lives in the sandbox home.
const LAYOUTS = {
  cursor: { dir: "/sandbox/agent", launcher: "/cursor-agent", name: "cursor-agent", authDir: `${HOME_IN}/.config/cursor`, tree: (src) => src.cursorTree, auth: (src) => src.cursorAuth },
  codex: { dir: "/sandbox/codex", launcher: "/bin/codex", name: "codex", authDir: `${HOME_IN}/.codex`, tree: (src) => src.codexTree, auth: (src) => src.codexAuth },
  opencode: { dir: "/sandbox/opencode", launcher: "", name: "opencode", file: true, authDir: `${HOME_IN}/.local/share/opencode`, tree: (src) => src.opencodeBin, auth: (src) => src.opencodeAuth },
  claude: { dir: "/sandbox/claude", launcher: "", name: "claude", file: true, authDir: `${HOME_IN}/.claude`, tree: (src) => src.claudeBin, auth: (src) => src.claudeAuth },
};
// The CLI marks itself non-dumpable unless this is set; OpenShell then denies its sockets (lib/builder.mjs).
const HARNESS_ENV = { cursor: { CURSOR_AGENT_ALLOW_PROCESS_INSPECTION: "1" } };
// Inside the sandbox: task writes are recorded for the host, builder commands are refused, the rest is the real CLI.
const CLI_SHIM = `#!/bin/sh
case "$1 $2" in
  "task list"|"task show"|"task outcomes") ;;
  task\\ *) d="\${AI_COLLAB_SANDBOX_OUT:-${OUT}}/ai-collab"; mkdir -p "$d" || exit 1; printf '%s\\0' "$@" > "$d/$(date +%s%N)-$$"
    echo "ai-collab: recorded; the host applies supported task commands when this run ends"; exit 0 ;;
  builder\\ *) echo "ai-collab: builder commands work on the host only" >&2; exit 2 ;;
esac
exec ${NODE_IN} ${APP_IN}/scripts/ai-collab.mjs "$@"
`;

/** The sandbox name for one schedule run: s-<first 8 of the name>-<6 hex>, at most 17 characters. */
export function runSandboxName(name, at = Date.now()) {
  const hash = createHash("sha256").update(`${name}@${at}`).digest("hex").slice(0, 6);
  return `s-${String(name).slice(0, NAME_PREFIX_MAX).replace(/-+$/, "")}-${hash}`;
}

/** The argv to run inside the sandbox: the harness binary replaced by its launcher's name, every other element kept. */
export function sandboxCommand(argv) {
  const harness = agentHarness(argv);
  if (!harness) throw new Error(`a sandboxed schedule runs an agent harness (claude, codex, cursor-agent, opencode), not ${basename(String(argv?.[0] ?? ""))}`);
  // By name: the exec env's PATH starts with /sandbox/tools/bin, where the launcher link lives (as lib/builder.mjs runs it).
  return [LAYOUTS[harness].name, ...argv.slice(1)];
}

/** Parses `--name N --cwd DIR [--project P] -- argv...`; throws on anything else. */
export function parseArgs(args) {
  const at = args.indexOf("--");
  if (at < 0 || at === args.length - 1) throw new Error("usage: sandbox-run.mjs --name N --cwd DIR [--project P] -- <command...>");
  const flags = {};
  for (let i = 0; i < at; i += 2) {
    if (!["--name", "--cwd", "--project"].includes(args[i]) || i + 1 >= at) throw new Error(`unknown option ${args[i]}`);
    flags[args[i].slice(2)] = args[i + 1];
  }
  if (!flags.name || !flags.cwd) throw new Error("--name and --cwd are required");
  return { ...flags, command: args.slice(at + 1) };
}

async function must(bin, args, env, what, timeoutMs = SYNC_TIMEOUT_MS) {
  const out = await runTool(bin, args, { env, timeoutMs });
  if (out.code !== 0) throw new Error(`${what} failed: ${(out.stderr || out.stdout || "").trim() || `exit ${out.code}`}`);
  return out.stdout;
}

const git = (cwd, args, env) => must("git", ["-C", cwd, ...args], env, `git ${args[0]}`);

// Uploads a directory unfiltered: .gitignore filtering would drop the clone's .git.
const uploadAll = (openshell, env, sandbox, local, remote) => must(openshell, ["sandbox", "upload", sandbox, `${local.replace(/\/+$/, "")}/`, `${remote.replace(/\/+$/, "")}/`, "--no-git-ignore"], env, "sandbox upload");

// Copies a credential through a 0600 temp file so it never appears in argv, env or a log.
async function uploadSecret(openshell, env, sandbox, file, remoteDir, name = basename(file)) {
  const dir = mkdtempSync(join(tmpdir(), "ai-collab-sandbox-run-auth-"));
  try {
    writeFileSync(join(dir, name), readFileSync(file), { mode: 0o600 });
    await uploadFile({ openshell, env, sandbox, local: join(dir, name), remoteDir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The host's ntfy token file from defaults.json, or "".
function hostTokenFile(env) {
  const file = autoDefaults(env)?.tokenFile;
  return typeof file === "string" && existsSync(file) ? file : "";
}

/** Builds the host-side staging: the clone, the tools tree, the sandbox home and the policy. */
export async function stage({ cwd, project, harness, dir, env, log }) {
  const clone = join(dir, basename(cwd));
  const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], env)).trim();
  await must("git", ["clone", "--quiet", "--no-hardlinks", ...(branch !== "HEAD" ? ["--branch", branch] : []), cwd, clone], env, "git clone");
  await git(clone, ["remote", "remove", "origin"], env);
  for (const key of ["user.name", "user.email"]) {
    const value = (await runTool("git", ["-C", cwd, "config", key], { env })).stdout.trim();
    if (value) await git(clone, ["config", key, value], env);
  }
  const base = (await git(clone, ["rev-parse", "HEAD"], env)).trim();
  const src = toolSources({ harness, root: cwd }, env);
  const layout = LAYOUTS[harness];
  const tree = layout.tree(src);
  if (!tree) throw new Error(`no ${harness} install found on the host`);
  if (!src.node) throw new Error("no node found on the host for the ai-collab CLI");
  const tools = join(dir, "tools");
  mkdirSync(join(tools, "bin"), { recursive: true });
  writeFileSync(join(tools, "bin", "ai-collab"), CLI_SHIM, { mode: 0o755 });
  for (const [bin, from] of [["git", src.git], ["oncebitten", src.oncebitten]]) {
    if (from) { cpSync(from, join(tools, "bin", bin)); chmodSync(join(tools, "bin", bin), 0o755); } else log(`no ${bin} found on the host; the sandbox has none`);
  }
  const libs = await sharedLibs(src.node, env);
  if (libs.length) {
    mkdirSync(join(tools, "lib"), { recursive: true });
    for (const lib of libs) {
      try { copyFileSync(realpathSync(lib), join(tools, "lib", basename(lib))); } catch { /* a library that vanished */ }
    }
  }
  for (const part of APP_PARTS) if (existsSync(join(APP_ROOT, part))) cpSync(join(APP_ROOT, part), join(tools, "ai-collab", part), { recursive: true });
  const inTree = `${layout.dir}/${basename(tree)}`;
  // Relative, so the link resolves wherever the sandbox root is mounted.
  symlinkSync(`../..${inTree.slice(SANDBOX.length)}${layout.launcher}`, join(tools, "bin", layout.name));
  const workdir = `${WORK}/${basename(cwd)}`;
  const home = join(dir, "home");
  const config = join(home, ".config", "ai-collab");
  mkdirSync(config, { recursive: true });
  const token = hostTokenFile(env);
  const ntfy = { url: NTFY, ...(token ? { tokenFile: TOKEN_IN } : {}) };
  writeFileSync(join(config, "defaults.json"), `${JSON.stringify({ ...ntfy, peers: "claude,codex,cursor,opencode" }, null, 2)}\n`);
  if (project) writeFileSync(join(config, "projects.json"), `${JSON.stringify([{ root: workdir, project, ...ntfy }], null, 2)}\n`);
  // The ai-collab MCP server, so set_identity, send_to_all and ask_question reach the operator over ntfy.
  const mcp = { command: NODE_IN, args: [`${APP_IN}/scripts/ai-collab-mcp.mjs`], env: { ...(project ? { AI_COLLAB_PROJECT: project } : {}), AI_COLLAB_PEER: harness } };
  if (harness === "cursor") { mkdirSync(join(home, ".cursor"), { recursive: true }); writeFileSync(join(home, ".cursor", "mcp.json"), `${JSON.stringify({ mcpServers: { "ai-collab": mcp } }, null, 2)}\n`); }
  if (harness === "claude") writeFileSync(join(home, ".claude.json"), `${JSON.stringify({ mcpServers: { "ai-collab": { type: "stdio", ...mcp } } }, null, 2)}\n`);
  // A snapshot of the project's tasks, so `ai-collab task list|show` answer from the host's state as of the start.
  const tasks = join(env.XDG_DATA_HOME || join(env.HOME || "", ".local", "share"), "ai-collab", "tasks", `${project}.json`);
  if (project && existsSync(tasks)) { mkdirSync(join(home, ".local", "share", "ai-collab", "tasks"), { recursive: true }); copyFileSync(tasks, join(home, ".local", "share", "ai-collab", "tasks", basename(tasks))); }
  const binaries = layout.file ? [inTree] : executables(harness === "codex" ? join(tree, "bin") : tree).map((f) => `${inTree}${harness === "codex" ? "/bin" : ""}/${f}`);
  const policy = join(dir, "policy.yaml");
  writeFileSync(policy, `${JSON.stringify(builderPolicy({ harness, binaries, ntfyBinaries: [NODE_IN] }), null, 2)}\n`);
  const execEnv = {
    HOME: HOME_IN, XDG_CONFIG_HOME: `${HOME_IN}/.config`, XDG_DATA_HOME: `${HOME_IN}/.local/share`, XDG_STATE_HOME: `${HOME_IN}/.local/state`,
    CODEX_HOME: `${HOME_IN}/.codex`, PATH: SANDBOX_PATH, TMPDIR: "/tmp", AI_COLLAB_SANDBOX_OUT: OUT, ...(project ? { AI_COLLAB_PROJECT: project } : {}),
    ...(src.gitCore ? { GIT_EXEC_PATH: `${TOOLS}/git-core` } : {}), ...(libs.length ? { LD_LIBRARY_PATH: `${TOOLS}/lib` } : {}),
    ...(HARNESS_ENV[harness] ?? {}),
  };
  return { clone, base, branch, tools, home, src, layout, tree, token, workdir, policy, execEnv };
}

// Regular executable files directly in a directory: the binaries a network policy names.
function executables(dir) {
  try {
    return readdirSync(dir).filter((f) => { const st = statSync(join(dir, f)); return st.isFile() && (st.mode & 0o111) !== 0; });
  } catch { return []; }
}

async function upload(openshell, env, sandbox, staged, harness, log) {
  const { src, layout } = staged;
  await uploadAll(openshell, env, sandbox, staged.clone, WORK);
  await uploadAll(openshell, env, sandbox, staged.tools, SANDBOX);
  await uploadAll(openshell, env, sandbox, staged.home, SANDBOX);
  if (src.gitCore) await uploadAll(openshell, env, sandbox, src.gitCore, TOOLS);
  await uploadFile({ openshell, env, sandbox, local: src.node, remoteDir: `${TOOLS}/node/bin` });
  if (layout.file) await uploadFile({ openshell, env, sandbox, local: staged.tree, remoteDir: layout.dir });
  else await uploadAll(openshell, env, sandbox, staged.tree, layout.dir);
  const auth = layout.auth(src);
  if (auth) await uploadSecret(openshell, env, sandbox, auth, layout.authDir);
  else log(`no host ${harness} login found; the harness will ask to log in`);
  // Claude and Codex logins for any harness, as builders get them (operator decision 2026-11-23).
  await uploadLogins({ openshell, env, sandbox, home: env.HOME, remoteHome: HOME_IN, log });
  if (staged.token) await uploadSecret(openshell, env, sandbox, staged.token, dirname(TOKEN_IN), basename(TOKEN_IN));
  if (src.nodeModules) {
    await uploadAll(openshell, env, sandbox, src.nodeModules, `${SANDBOX}/deps`);
    await must(openshell, execArgv({ openshell, sandbox, command: ["ln", "-sfn", `${SANDBOX}/deps/${basename(src.nodeModules)}`, `${staged.workdir}/node_modules`] }).slice(1), env, "sandbox exec ln");
  }
}

/** Downloads the clone, commits loose work, and fetches new commits into cwd's repo as sandbox/<name>-<stamp>; returns that branch or "". */
export async function land({ openshell, env, sandbox, cwd, name, staged, dir, log, now = Date.now() }) {
  await runTool(openshell, execArgv({ openshell, sandbox, command: ["rm", "-f", `${staged.workdir}/node_modules`] }).slice(1), { env });
  const back = join(dir, "back", basename(cwd));
  mkdirSync(dirname(back), { recursive: true });
  await must(openshell, ["sandbox", "download", sandbox, staged.workdir, back], env, "sandbox download");
  if (!existsSync(join(back, ".git"))) throw new Error("the downloaded workspace has no git repository");
  if ((await git(back, ["status", "--porcelain"], env)).trim()) {
    await git(back, ["add", "-A"], env);
    await git(back, ["commit", "--quiet", "--no-verify", "-m", `chore(sandbox): uncommitted work from schedule ${name}`], env);
  }
  const ahead = Number((await git(back, ["rev-list", "--count", `${staged.base}..HEAD`], env)).trim()) || 0;
  if (!ahead) { log("no new commits"); return ""; }
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const target = `sandbox/${name}-${stamp}`;
  await git(cwd, ["fetch", "--quiet", back, `HEAD:refs/heads/${target}`], env);
  log(`${ahead} commit(s) on branch ${target} in ${cwd}`);
  return target;
}

/** Replays supported task calls through the host CLI; others are logged and dropped. */
export async function replayTasks({ dir, project, env, log, name }) {
  const recorded = join(dir, "out", "ai-collab");
  if (!existsSync(recorded)) return 0;
  let count = 0;
  for (const file of readdirSync(recorded).sort()) {
    const argv = parseRecordedCall(readFileSync(join(recorded, file), "utf8"));
    const outcome = name === "pm" && argv[0] === "task" && ["propose-outcome", "report-outcome"].includes(argv[1]);
    if (!outcome && !replayable(argv)) { log(`dropped recorded call: ${argv.slice(0, 2).join(" ")}`); continue; }
    const out = await runTool(process.execPath, [CLI, ...argv], { env: { ...env, AI_COLLAB_PROJECT: project } });
    if (out.code === 0) count += 1; else log(`recorded call failed: ${(out.stderr || "").trim()}`);
  }
  return count;
}

/** Runs one command in a fresh sandbox; resolves the harness's exit code. */
export async function sandboxRun({ name, cwd, project, command }, { env = process.env, log = (line) => process.stderr.write(`sandbox-run ${name}: ${line}\n`), stdout = process.stdout, stderr = process.stderr } = {}) {
  const harness = agentHarness(command);
  const inner = sandboxCommand(command);
  if (!existsSync(join(cwd, ".git"))) throw new Error(`${cwd} is not a git work tree; a sandboxed run needs one to land its commits`);
  const openshell = env.AI_COLLAB_OPENSHELL_BIN || "openshell";
  // Over the cap a tick is skipped, not failed: the next tick tries again.
  const capped = await sandboxCapRefusal({ openshell, env });
  if (capped) { log(`skipped: ${capped}; the next tick tries again`); return 0; }
  const proj = project || projectOfFolder(cwd, listProjects(env));
  mkdirSync(stateDir(env), { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(stateDir(env), "sandbox-run-"));
  let keep = false;
  const sandbox = runSandboxName(name);
  let child = null;
  let stopping = false;
  const onTerm = () => { stopping = true; child?.kill("SIGTERM"); };
  process.once("SIGTERM", onTerm);
  process.once("SIGINT", onTerm);
  let created = false;
  try {
    const staged = await stage({ cwd, project: proj, harness, dir: join(dir, "stage"), env, log });
    await must(openshell, ["sandbox", "create", "--name", sandbox, "--no-tty", "--detach", "--policy", staged.policy], env, "sandbox create");
    created = true;
    log(`sandbox ${sandbox} created`);
    await upload(openshell, env, sandbox, staged, harness, log);
    let code = 143;
    if (!stopping) {
      const argv = execArgv({ openshell, sandbox, workdir: staged.workdir, env: staged.execEnv, command: inner });
      log(`running ${harness} in ${staged.workdir}`);
      child = spawn(argv[0], argv.slice(1), { env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (chunk) => stdout.write(chunk));
      child.stderr.on("data", (chunk) => stderr.write(chunk));
      code = await new Promise((resolve) => { child.once("error", () => resolve(127)); child.once("close", (c) => resolve(c ?? 143)); });
      child = null;
    }
    try {
      await land({ openshell, env, sandbox, cwd, name, staged, dir, log });
    } catch (error) {
      keep = true;
      log(`could not land the work; staging kept in ${dir}: ${error.message}`);
    }
    const got = await runTool(openshell, ["sandbox", "download", sandbox, OUT, join(dir, "out")], { env, timeoutMs: SYNC_TIMEOUT_MS });
    if (got.code === 0 && proj) log(`${await replayTasks({ dir, project: proj, env, log, name })} recorded task call(s) applied`);
    return code;
  } finally {
    process.removeListener("SIGTERM", onTerm);
    process.removeListener("SIGINT", onTerm);
    if (created && keep) log(`sandbox ${sandbox} kept so its work is not lost; delete it with: openshell sandbox delete ${sandbox}`);
    else if (created) {
      const gone = await destroySandbox({ openshell, env, name: sandbox });
      log(gone.ok ? `sandbox ${sandbox} deleted` : `sandbox delete failed: ${gone.detail}`);
    }
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArgs(process.argv.slice(2));
    process.exitCode = await sandboxRun(args);
  } catch (error) {
    process.stderr.write(`sandbox-run: ${error.message}\n`);
    process.exitCode = 1;
  }
}
