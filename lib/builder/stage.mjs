// Host-side staging and upload: the clone, tools tree, sandbox home and policy for one builder.
import * as S from "../sandbox.ts";
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { cursorBinary, findExecutable } from "../start.mjs";
import { openTasks } from "../tasks.mjs";
import { HOME_IN, NTFY_TOKEN_IN, OUT, SANDBOX, TOOLS, WORK } from "../sandbox.ts";
import { APP_ROOT, BASE_REF, GIT_TIMEOUT_MS, SYNC_TIMEOUT_MS, updateState } from "./state.mjs";
import { APP_IN, CLAUDE_SETTINGS_IN, CLAUDE_MCP_IN, CURSOR_DIR, CODEX_DIR, OPENCODE_DIR, CLAUDE_DIR, CODE_MCP, NTFY_HOST, NTFY_PORT, CLAUDE_ENV, CURSOR_ENV, builderPolicy, claudeSettings, claudeMcpConfig, captureHooks, hostCaptureEvents } from "./policy.mjs";

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

const APP_PARTS = ["package.json", "scripts", "lib", "web/lib"];

const SANDBOX_PATH = `${TOOLS}/bin:${TOOLS}/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

// glibc libraries the sandbox image provides itself; host copies would not match its loader.
const GLIBC_LIB = /^(libc|libm|libdl|libpthread|librt|ld-linux[^.]*)\.so/;

export async function git(cwd, args, env) {
  const res = await S.runTool("git", ["-C", cwd, ...args], { env, timeoutMs: GIT_TIMEOUT_MS });
  if (res.code !== 0) throw new Error(`git ${args[0]} failed: ${(res.stderr || "").trim() || `exit ${res.code}`}`);
  return res.stdout;
}

export function must(bin, args, env, what) {
  return S.must(bin, args, { env, timeoutMs: SYNC_TIMEOUT_MS, what });
}

// Creates this builder's own sandbox; an existing one with the name is never reused or touched.
export async function createSandbox({ openshell, env, name, policy }) {
  const list = await S.runTool(openshell, ["sandbox", "list", "-o", "json"], { env });
  if (list.code !== 0) throw new Error(`openshell sandbox list failed: ${list.stderr.trim() || `exit ${list.code}`}`);
  if (S.parseSandboxList(list.stdout).some((s) => s?.name === name)) throw new Error(`sandbox ${name} already exists`);
  await must(openshell, ["sandbox", "create", "--name", name, "--no-tty", "--detach", "--policy", policy], env, "sandbox create");
}

export async function uploadBuilderSandbox(state, paths, staged, context) {
  const { openshell, env } = context;
  await createSandbox({ openshell, env, name: state.sandbox, policy: paths.policy });
  updateState(paths, { sandboxCreated: true });
  await upload(state, paths, staged, context);
}

export async function upload(state, paths, staged, { openshell, env, log }) {
  const { src, layout } = staged;
  const uploaded = await S.stageAndUpload({
    openshell, env, sandbox: state.sandbox, log,
    staged: { clone: staged.clone, tools: staged.tools, home: staged.home, workdir: staged.workdir, node: src.node, gitCore: src.gitCore, npm: src.npm, nodeModules: src.nodeModules, ntfyToken: src.ntfyToken },
    layout, style: {}, authMissing: `no host ${state.harness} credentials; the harness will ask to log in`, secretTmp: "ai-collab-builder-auth-",
  });
  if (layout.auth) staged.authHash = uploaded.authHash;
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

export function findOncebitten(env) {
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

// Whether the host has the harness's install, by the same lookup the sandbox staging uses.
export function hasInstall(harness, state, env) {
  return Boolean(harnessLayout(harness, toolSources({ ...state, harness }, env)).tree);
}

// Builds the host-side staging: a self-contained clone, the tools tree, the sandbox home and the policy.
export async function stage(state, paths, { env, log, resume }) {
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
