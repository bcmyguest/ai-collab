// Claude and Codex in OpenShell: the host CLI uploaded into a per-project sandbox and run over `openshell sandbox exec`.
// One sandbox per harness and project, shared by its sessions and deleted when the last one closes; each session's
// worktree is uploaded as a git clone and landed on the host worktree on close, as Cursor's and OpenCode's are.
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions as NodeSpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { builderPolicy, CLAUDE_DIR, CODEX_DIR } from "../../lib/builder/policy.ts";
import {
  destroyOwnedSandboxes, ensureSandbox, execArgv, executables, harnessLogins, harnessSandboxName, HOME_IN, runTool, sandboxLabels, uploadFile, uploadSecret, uploadTree, WORK,
} from "../../lib/sandbox.ts";
import { findExecutable } from "../../lib/sessions/scope.ts";
import { MANAGED_ENV } from "../../lib/subagent-guard.ts";
import { syncSandboxBack, uploadClone } from "./cursor.mjs";

// oxlint-disable-next-line typescript/no-explicit-any -- session records and SDK spawn options are JSON
type Json = any;
type Log = (line: string) => void;
/** What a sandbox gets of a host CLI: a file or a tree, where it goes, the launcher path inside, and the binaries the policy names. */
export type Install = { local: string; file: boolean; dir: string; bin: string; binaries: string[] };
type Box = { name: string; project: string; owner: string; bin: string; uploaded: Set<string>; ready: Promise<void> };
type Spawn = (file: string, args: string[], options: NodeSpawnOptions) => ChildProcess;

export const CLAUDE_IN = `${CLAUDE_DIR}/claude`;
// The env a sandboxed CLI starts with; the host env never crosses, so no host path or secret reaches argv.
const BASE_ENV = { HOME: HOME_IN, XDG_CONFIG_HOME: `${HOME_IN}/.config`, TMPDIR: "/tmp" };
// Documented in code.claude.com/docs/en/env-vars; the policy allows only Claude's API hosts, so other traffic would hang.
const CLAUDE_QUIET = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1" };
// SDK and ai-collab variables a sandboxed Claude keeps from the env the SDK hands its spawner; secrets never.
const CLAUDE_PASS = /^(CLAUDE_CODE_|CLAUDE_AGENT_SDK_|AI_COLLAB_(OWNED|PARENT|MANAGED)$)/;
const SECRET = /TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL/;
const EXIT_WAIT_MS = 5_000;
const STDERR_LINE_MAX = 500;

const real = (file: string) => { try { return file ? realpathSync(file) : ""; } catch { return ""; } };

/** The Claude Code binary a sandbox gets: AI_COLLAB_CLAUDE_BIN, else the SDK's bundled Linux binary, else `claude` on PATH. */
export function claudeInstall(env: NodeJS.ProcessEnv): Install {
  const local = env.AI_COLLAB_CLAUDE_BIN || bundledClaude() || real(findExecutable("claude", env.PATH ?? ""));
  if (!local) throw new Error("no Claude Code binary to upload into OpenShell; set AI_COLLAB_CLAUDE_BIN");
  return { local, file: true, dir: CLAUDE_DIR, bin: CLAUDE_IN, binaries: [CLAUDE_IN] };
}

// The native CLI the Agent SDK ships for this machine (glibc Linux, as the sandbox image is); the same version the SDK speaks.
function bundledClaude() {
  if (process.platform !== "linux") return "";
  try { return createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude`); } catch { return ""; }
}

/** The Codex install a sandbox gets: AI_COLLAB_CODEX_TREE, else the release tree holding the host `codex` (bin/codex inside), as builders upload it. */
export function codexInstall(env: NodeJS.ProcessEnv): Install {
  const found = real(findExecutable("codex", env.PATH ?? ""));
  const tree = env.AI_COLLAB_CODEX_TREE || (found ? dirname(dirname(found)) : "");
  if (!tree || !existsSync(join(tree, "bin", "codex"))) throw new Error("no Codex install to upload into OpenShell; set AI_COLLAB_CODEX_TREE to a tree with bin/codex");
  const inTree = `${CODEX_DIR}/${basename(tree)}`;
  return { local: tree, file: false, dir: CODEX_DIR, bin: `${inTree}/bin/codex`, binaries: executables(join(tree, "bin")).map((f) => `${inTree}/bin/${f}`) };
}

/** The env a sandboxed Codex app-server runs with: the sandbox home and its CODEX_HOME, the owned marker, and the managed marker for a managed session. */
export function codexSandboxEnv(managed: boolean) {
  return { ...BASE_ENV, CODEX_HOME: `${HOME_IN}/.codex`, AI_COLLAB_OWNED: "codex", ...(managed ? { [MANAGED_ENV]: "1" } : {}) };
}

/** The env a sandboxed Claude runs with: the SDK's own variables (no secrets), the sandbox home and the quiet switches. */
export function claudeSandboxEnv(sdkEnv: Record<string, string | undefined>) {
  const kept = Object.entries(sdkEnv).filter((pair): pair is [string, string] => typeof pair[1] === "string" && CLAUDE_PASS.test(pair[0]) && !SECRET.test(pair[0]));
  return { ...Object.fromEntries(kept), ...BASE_ENV, ...CLAUDE_QUIET };
}

/**
 * The SDK's spawnClaudeCodeProcess for a sandbox: the CLI argv the SDK built, run as `openshell sandbox exec` over stdio.
 * The SDK's cwd is the sandbox workdir. kill() also destroys the pipes, since the exec client may not be what holds them.
 */
export function claudeSpawner({ openshell, env, sandbox, workdir, log, spawn = nodeSpawn }: { openshell: string; env: NodeJS.ProcessEnv; sandbox: string; workdir: string; log: Log; spawn?: Spawn }) {
  const children = new Set<ChildProcess>();
  const spawner = (o: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal?: AbortSignal }) => {
    const argv = execArgv({ openshell, sandbox, workdir: o.cwd || workdir, env: claudeSandboxEnv(o.env), command: [CLAUDE_IN, ...o.args] });
    const child = spawn(argv[0], argv.slice(1), { env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    const destroy = () => { for (const stream of [child.stdin, child.stdout, child.stderr]) if (stream && !stream.destroyed) stream.destroy(); };
    const kill = child.kill.bind(child);
    child.kill = (signal?: NodeJS.Signals | number) => { const ok = kill(signal); destroy(); return ok; };
    child.stdin?.on("error", () => {});
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { for (const line of chunk.split("\n")) if (line.trim()) log(`claude: ${line.trimEnd().slice(0, STDERR_LINE_MAX)}`); });
    children.add(child);
    child.once("exit", () => children.delete(child));
    o.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    return child;
  };
  // Waits up to EXIT_WAIT_MS for every CLI to exit after the SDK closed its stdin, then kills what is left.
  const stopped = async () => {
    await Promise.all([...children].map((child) => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, EXIT_WAIT_MS);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    })));
  };
  return { spawner, stopped };
}

// cursor.mjs is untyped JS; its inferred log parameter takes no argument.
const landWork: Json = syncSandboxBack;

/** The per-project sandboxes one harness's runner sessions share; `install` names what to upload, `label` and `trailer` mark the landing. */
export function createCliSandbox({ env = process.env, harness, label, trailer, install }: {
  env?: NodeJS.ProcessEnv; harness: "claude" | "codex"; label: string; trailer: string; install: (env: NodeJS.ProcessEnv) => Install;
}) {
  const openshell = env.AI_COLLAB_OPENSHELL_BIN || "openshell";
  const boxes = new Map<string, Box>(); // sandbox name -> its staged state, for this runner's lifetime
  const claims = new Map<string, Set<string>>(); // sandbox name -> the sessions (and restored records) that hold it
  const ownerOf = (project: string) => `${harness}-${project}`;
  const exec = (name: string, command: string[]) => runTool(openshell, execArgv({ openshell, sandbox: name, command }).slice(1), { env });

  function claim(name: string, id: string) {
    const set = claims.get(name) ?? new Set();
    set.add(id);
    claims.set(name, set);
  }

  // Creates or reuses the sandbox under the harness policy, uploads the CLI when missing, and the harness's own login.
  async function startBox(box: Box, home: string, log: Log) {
    const inst = install(env);
    const dir = mkdtempSync(join(tmpdir(), `ai-collab-${harness}-policy-`));
    try {
      const policy = join(dir, "policy.yaml");
      writeFileSync(policy, `${JSON.stringify(builderPolicy({ harness, binaries: inst.binaries }), null, 2)}\n`, { mode: 0o600 });
      await ensureSandbox({ openshell, env, name: box.name, policy, labels: sandboxLabels({ project: box.project, kind: "session", owner: box.owner }) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // The CLI is a few hundred MB, so a sandbox that already has it keeps it.
    if ((await exec(box.name, ["test", "-x", inst.bin])).code !== 0) {
      if (inst.file) {
        await uploadFile({ openshell, env, sandbox: box.name, local: inst.local, remoteDir: inst.dir });
        if (basename(inst.local) !== basename(inst.bin)) {
          const moved = await exec(box.name, ["mv", `${inst.dir}/${basename(inst.local)}`, inst.bin]);
          if (moved.code !== 0) throw new Error(`could not install ${harness} in ${box.name}: ${moved.stderr.trim()}`);
        }
      } else {
        await uploadTree({ openshell, env, sandbox: box.name, local: inst.local, remote: inst.dir, gitIgnore: false });
      }
    }
    for (const login of harnessLogins(env, home).filter((l) => l.harness === harness)) {
      await uploadSecret({ openshell, env, sandbox: box.name, file: login.file, remoteDir: login.remoteDir, tmpPrefix: `ai-collab-${harness}-secret-` })
        .catch((error: Error) => log(`${label}: could not copy the login into ${box.name}: ${error.message.split("\n")[0]}`));
    }
    box.bin = inst.bin;
  }

  async function boxFor(project: string, home: string, log: Log): Promise<Box> {
    const name = harnessSandboxName(harness, project);
    const known = boxes.get(name);
    if (known) { await known.ready; return known; }
    const box: Box = { name, project, owner: ownerOf(project), bin: "", uploaded: new Set(), ready: Promise.resolve() };
    boxes.set(name, box);
    box.ready = startBox(box, home, log);
    try {
      await box.ready;
    } catch (error) {
      if (boxes.get(name) === box) boxes.delete(name);
      throw error;
    }
    return box;
  }

  // Uploads a session's worktree as a clone under /sandbox/work; a resume keeps the one already there.
  async function stageWork(box: Box, cwd: string, keepExisting: boolean) {
    const workdir = `${WORK}/${basename(cwd)}`;
    if (box.uploaded.has(cwd)) return workdir;
    const present = keepExisting && (await exec(box.name, ["test", "-d", workdir])).code === 0;
    if (!present) {
      if (existsSync(join(cwd, ".git"))) await uploadClone({ openshell, env, sandbox: box.name, cwd, remote: WORK });
      else await uploadTree({ openshell, env, sandbox: box.name, local: cwd, remote: WORK });
    }
    box.uploaded.add(cwd);
    return workdir;
  }

  // Lands the session's work on its host worktree, drops its claim, and deletes the sandbox with the last claim.
  async function releaseClaim(name: string, id: string, project: string, cwd: string, log: Log) {
    const set = claims.get(name);
    if (!set?.has(id)) return true;
    let ok = true;
    if (cwd) ok = await landWork({ openshell, env, sandbox: name, cwd, log, label, trailer });
    boxes.get(name)?.uploaded.delete(cwd);
    set.delete(id);
    if (set.size) return ok;
    claims.delete(name);
    boxes.delete(name);
    const out = await destroyOwnedSandboxes({ openshell, env, project, kind: "session", owner: ownerOf(project), log });
    if (!out.ok) log(`${label}: could not delete sandbox ${name}: ${out.detail}`);
    return ok && out.ok;
  }

  async function syncBack(name: string, cwd: string, log: Log) {
    const status = await exec(name, ["git", "-C", `${WORK}/${basename(cwd)}`, "status", "--porcelain"]);
    if (status.code !== 0) throw new Error(`git status in the sandbox failed: ${status.stderr.trim() || `exit ${status.code}`}`);
    if (status.stdout.trim()) throw new Error("commit your work in the sandbox first");
    if (!(await landWork({ openshell, env, sandbox: name, cwd, log, label, trailer }))) throw new Error("could not copy the sandbox commits to the host worktree");
  }

  return {
    openshell,
    /**
     * Claims the project's sandbox for one session, stages it and uploads the worktree. `id` is the session's claim (a
     * resume passes its address, which a restored record already holds); a failed open drops a new claim, a failed resume keeps it.
     */
    async open({ project, cwd, home = env.HOME || homedir(), log, id = randomUUID(), resume = false }: { project: string; cwd: string; home?: string; log: Log; id?: string; resume?: boolean }) {
      const name = harnessSandboxName(harness, project);
      claim(name, id);
      let box: Box | undefined;
      try {
        box = await boxFor(project, home, log);
        const workdir = await stageWork(box, cwd, resume);
        const bin = box.bin;
        let closed = false;
        return {
          name, workdir,
          /** Argv that runs the CLI with args in the session's workdir. */
          argv: (args: string[], vars: Record<string, string>) => execArgv({ openshell, sandbox: name, workdir, env: vars, command: [bin, ...args] }),
          syncBack: (sessionLog: Log) => syncBack(name, cwd, sessionLog),
          /** Lands the work and releases the claim once. */
          close: async (sessionLog: Log) => {
            if (closed) return true;
            closed = true;
            return releaseClaim(name, id, project, cwd, sessionLog);
          },
        };
      } catch (error) {
        if (!resume) await releaseClaim(name, id, project, box ? cwd : "", log);
        throw error;
      }
    },
    /** A record restored after a runner restart holds its sandbox until it resumes or is released. */
    restore(record: Json) {
      if (record?.place !== "openshell" || record.status === "ended" || !record.address || record.builder) return;
      claim(harnessSandboxName(harness, record.project), record.address);
    },
    /** Ends a restored record that never resumed: lands its work and deletes the sandbox when no other session holds it. */
    release(record: Json) {
      if (record?.place !== "openshell" || !record.address || record.builder) return Promise.resolve(true);
      return releaseClaim(harnessSandboxName(harness, record.project), record.address, record.project, record.cwd, () => {});
    },
  };
}

/** Claude Code's sandbox host: its binary in /sandbox/claude, its OAuth login, and its commits trailed as Claude's. */
export function createClaudeSandbox({ env = process.env, install = claudeInstall }: { env?: NodeJS.ProcessEnv; install?: (env: NodeJS.ProcessEnv) => Install } = {}) {
  return createCliSandbox({ env, harness: "claude", label: "claude", trailer: "Assisted-by: Claude:claude-code", install });
}

/** Codex's sandbox host: its release tree in /sandbox/codex, its login, and its commits trailed as Codex's. */
export function createCodexSandbox({ env = process.env, install = codexInstall }: { env?: NodeJS.ProcessEnv; install?: (env: NodeJS.ProcessEnv) => Install } = {}) {
  return createCliSandbox({ env, harness: "codex", label: "codex", trailer: "Assisted-by: Codex:codex", install });
}

export type CliSandbox = ReturnType<typeof createCliSandbox>;
export type CliBox = Awaited<ReturnType<CliSandbox["open"]>>;
