// OpenShell sandboxes: CLI calls, the sandbox cap, and the staged upload that builders and scheduled runs share.
// Verified against openshell 0.1.9 on 2026-11-22 (docs/owned-sessions-contract.md, OpenShell section).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { autoDefaults } from "./config.mjs";

export type Env = NodeJS.ProcessEnv;
export type Run = { code: number | null; stdout: string; stderr: string };
export type RunOptions = { env?: Env; cwd?: string; timeoutMs?: number; stdin?: string };
// errorPrefix: "openshell " for builders and ensureSandbox, "" for sandbox-run; stdoutFallback: the error may read stdout.
export type Style = { errorPrefix?: string; stdoutFallback?: boolean };
export type GitRunner = (cwd: string, args: string[]) => Promise<string>;
export type Layout = { dir: string; file?: boolean; tree: string; auth?: string; authDir: string };
export type Staged = {
  clone: string; tools: string; home: string; workdir: string;
  node?: string; gitCore?: string; npm?: string; nodeModules?: string; ntfyToken?: string;
};
export type SandboxRecord = { name?: string; phase?: string; state?: string; status?: unknown };
export type UploadArgs = {
  openshell: string; env: Env; sandbox: string; log: (line: string) => void;
  staged: Staged; layout: Layout; style: Style; authMissing: string;
  // The temp dir prefix for this caller's secret copies; a name only, kept per caller so a recorded argv does not change.
  secretTmp: string;
  logins?: { home: string | undefined; remoteHome: string };
};

export const SANDBOX = "/sandbox";
export const WORK = `${SANDBOX}/work`;
export const TOOLS = `${SANDBOX}/tools`;
export const HOME_IN = `${SANDBOX}/home`;
export const OUT = `${SANDBOX}/out`;
export const DEPS = `${SANDBOX}/deps`;
export const NTFY_TOKEN_IN = `${HOME_IN}/.config/ai-collab/ntfy-token`;
// The cap on OpenShell sandboxes when defaults.json names no maxSandboxes (operator decision 2026-11-23).
export const DEFAULT_MAX_SANDBOXES = 6;
// openshell 0.1.9 refuses a sandbox name over 19 characters (measured 2026-11-22).
const SANDBOX_NAME_MAX = 19;
const SETUP_TIMEOUT_MS = 60_000;
export const SYNC_TIMEOUT_MS = 600_000;
export const UPLOAD_TIMEOUT_MS = 900_000;
// run_code's shared sandbox and its per-call read sandboxes (lib/code-run.mjs) sit outside the cap.
const CAP_EXEMPT = /^(ai-collab-code$|aic-ro-)/;

/** Lowercase DNS-label-safe sandbox name for a project. */
export function sandboxName(project: string): string {
  const slug = String(project).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const name = `ai-collab-${slug}`;
  if (slug && name.length <= SANDBOX_NAME_MAX) return name;
  const suffix = createHash("sha256").update(String(project)).digest("hex").slice(0, 8);
  return `ai-collab-${suffix}`;
}

/** The sandbox a team run's OpenShell members share: team-<14 hex of project/run>. */
export function teamSandboxName(project: string, run: string): string {
  return "team-" + createHash("sha256").update(project + "/" + run).digest("hex").slice(0, 14);
}

/** The phase a sandbox JSON record reports; 0.1.9 writes "Ready" on `sandbox get` and `sandbox list`. */
export function sandboxPhase(sandbox: any): string {
  return String(sandbox?.phase ?? sandbox?.state ?? sandbox?.status?.phase ?? sandbox?.status ?? "");
}

/** The start/resume step for a sandbox in a non-ready phase, or null when it needs none. */
export function stateCommand(name: string, phase: string): string[] | null {
  if (/suspend/i.test(phase)) return ["resume", name];
  if (/stop|exited|terminated/i.test(phase)) return ["start", name];
  return null;
}

/** Argv that runs a command in a sandbox; env pairs come first, then `--workdir`, then the command. */
export function execArgv({ openshell, sandbox, workdir, env = {}, command }: { openshell: string; sandbox: string; workdir?: string; env?: Record<string, string>; command: string[] }): string[] {
  return [
    openshell, "sandbox", "exec", "--no-tty", "-n", sandbox,
    ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    ...(workdir ? ["--workdir", workdir] : []),
    "--", ...command,
  ];
}

/** Argv that copies a host directory into a sandbox; both paths end in "/" so the basename is kept. */
export function uploadArgv({ openshell, sandbox, local, remote }: { openshell: string; sandbox: string; local: string; remote: string }): string[] {
  return [openshell, "sandbox", "upload", sandbox, `${local.replace(/\/+$/, "")}/`, `${remote.replace(/\/+$/, "")}/`];
}

/** Argv that copies a sandbox path back to the host. */
export function downloadArgv({ openshell, sandbox, remote, local }: { openshell: string; sandbox: string; remote: string; local: string }): string[] {
  return [openshell, "sandbox", "download", sandbox, remote, local];
}

/** Runs a short-lived tool to completion; never rejects, so a missing binary reports through `stderr`. */
export function runTool(bin: string, args: string[], { env, cwd, timeoutMs = SETUP_TIMEOUT_MS, stdin }: RunOptions = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env, cwd, shell: false, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => { stdout += d; });
    child.stderr?.on("data", (d: string) => { stderr += d; });
    if (stdin !== undefined) { child.stdin?.on("error", () => {}); child.stdin?.end(stdin); }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** Runs a command to completion, throwing `<prefix><what> failed: <detail>` on a non-zero exit. */
export async function must(bin: string, args: string[], { env, timeoutMs, what, errorPrefix = "openshell ", stdoutFallback = false }: { env?: Env; timeoutMs?: number; what: string } & Style): Promise<Run> {
  const out = await runTool(bin, args, { env, timeoutMs });
  if (out.code === 0) return out;
  const detail = (stdoutFallback ? out.stderr || out.stdout || "" : out.stderr || "").trim() || `exit ${out.code}`;
  throw new Error(`${errorPrefix}${what} failed: ${detail}`);
}

/** A git runner for a host command: runs `git -C cwd args`, returns stdout, throws with `git <verb> failed:`. */
export function gitIn(env: Env, timeoutMs = UPLOAD_TIMEOUT_MS): GitRunner {
  return async (cwd, args) => (await must("git", ["-C", cwd, ...args], { env, timeoutMs, what: `git ${args[0]}`, errorPrefix: "", stdoutFallback: true })).stdout;
}

/** Parses `openshell sandbox list -o json`; throws when the reply is not JSON. */
export function parseSandboxList(stdout: string): SandboxRecord[] {
  let parsed: any;
  try { parsed = JSON.parse(stdout); } catch { throw new Error("openshell sandbox list printed no JSON"); }
  return Array.isArray(parsed?.sandboxes) ? parsed.sandboxes : [];
}

/**
 * Lists sandboxes once, then creates the named one when it is missing, starts or resumes it when its
 * phase says so. Throws an Error whose message the operator can act on; never prints a secret.
 */
export async function ensureSandbox({ openshell, env, name, policy, recreateBroken = false }: { openshell: string; env?: Env; name: string; policy?: string; recreateBroken?: boolean }): Promise<string> {
  const list = await runTool(openshell, ["sandbox", "list", "-o", "json"], { env });
  if (list.code !== 0) throw new Error(`openshell sandbox list failed: ${list.stderr.trim() || `exit ${list.code}`}`);
  let found: SandboxRecord | undefined = parseSandboxList(list.stdout).find((s) => s?.name === name);
  // A sandbox in Error never becomes ready; a caller whose sandbox holds no work (run_code) replaces it.
  if (found && recreateBroken && /error|fail/i.test(sandboxPhase(found))) {
    await must(openshell, ["sandbox", "delete", name], { env, timeoutMs: SYNC_TIMEOUT_MS, what: "sandbox delete" });
    found = undefined;
  }
  if (found) {
    const step = stateCommand(name, sandboxPhase(found));
    if (!step) return name;
    await must(openshell, ["sandbox", ...step], { env, what: `sandbox ${step[0]}` });
    return name;
  }
  await must(openshell, [
    "sandbox", "create", "--name", name, "--no-tty", "--detach",
    ...(policy ? ["--policy", policy] : []),
  ], { env, timeoutMs: SYNC_TIMEOUT_MS, what: "sandbox create" });
  return name;
}

/** Uploads a host directory into a sandbox; a tree git filtering empties is retried unfiltered. */
export async function uploadTree({ openshell, env, sandbox, local, remote, gitIgnore = true }: { openshell: string; env?: Env; sandbox: string; local: string; remote: string; gitIgnore?: boolean }): Promise<Run> {
  const args = uploadArgv({ openshell, sandbox, local, remote }).slice(1);
  if (!gitIgnore) args.push("--no-git-ignore");
  const out = await runTool(openshell, args, { env, timeoutMs: SYNC_TIMEOUT_MS });
  // Inside a work tree openshell drops .gitignore matches, and a tree with no tracked files uploads nothing.
  if (gitIgnore && out.code !== 0 && /Git filtering selected no files/i.test(out.stderr)) {
    return must(openshell, [...args.slice(0, 2), "--no-git-ignore", ...args.slice(2)], { env, timeoutMs: SYNC_TIMEOUT_MS, what: "sandbox upload" });
  }
  if (out.code !== 0) throw new Error(`openshell sandbox upload failed: ${out.stderr.trim() || `exit ${out.code}`}`);
  return out;
}

/** Uploads a host directory unfiltered: .gitignore filtering would drop the clone's .git and every dependency. */
export function uploadAll({ openshell, env, sandbox, local, remote, timeoutMs = UPLOAD_TIMEOUT_MS, errorPrefix, stdoutFallback }: { openshell: string; env?: Env; sandbox: string; local: string; remote: string; timeoutMs?: number } & Style): Promise<Run> {
  return must(openshell, ["sandbox", "upload", sandbox, `${local.replace(/\/+$/, "")}/`, `${remote.replace(/\/+$/, "")}/`, "--no-git-ignore"], { env, timeoutMs, what: "sandbox upload", errorPrefix, stdoutFallback });
}

/** Uploads one host file into a sandbox directory; a trailing slash on the directory keeps the file's own name. */
export async function uploadFile({ openshell, env, sandbox, local, remoteDir }: { openshell: string; env?: Env; sandbox: string; local: string; remoteDir: string }): Promise<Run> {
  const dest = `${remoteDir.replace(/\/+$/, "")}/`;
  return must(openshell, ["sandbox", "upload", sandbox, local, dest, "--no-git-ignore"], { env, timeoutMs: SYNC_TIMEOUT_MS, what: "sandbox upload" });
}

/** Downloads a sandbox path to a host path. */
export async function downloadTree({ openshell, env, sandbox, remote, local, timeoutMs = SYNC_TIMEOUT_MS, errorPrefix, stdoutFallback }: { openshell: string; env?: Env; sandbox: string; remote: string; local: string; timeoutMs?: number } & Style): Promise<Run> {
  return must(openshell, downloadArgv({ openshell, sandbox, remote, local }).slice(1), { env, timeoutMs, what: "sandbox download", errorPrefix, stdoutFallback });
}

/** Deletes a sandbox; never throws, so a failed cleanup cannot mask the session's own error. */
export async function destroySandbox({ openshell, env, name }: { openshell: string; env?: Env; name: string }): Promise<{ ok: boolean; detail: string }> {
  const out = await runTool(openshell, ["sandbox", "delete", name], { env, timeoutMs: SYNC_TIMEOUT_MS });
  return { ok: out.code === 0, detail: (out.stderr || out.stdout).trim() };
}

/** Names of sandboxes this runner owns for a project. */
export function ownedSandboxNames(project: string): string[] {
  return [sandboxName(project)];
}

/** The sandbox cap: defaults.json maxSandboxes when a positive integer, else DEFAULT_MAX_SANDBOXES. */
export function maxSandboxes(env: Env = process.env): number {
  const value = (autoDefaults(env) as { maxSandboxes?: number } | null)?.maxSandboxes;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_SANDBOXES;
}

/** The sandbox names the cap counts: every one but run_code's. */
export function countedSandboxes(names: unknown[]): string[] {
  return names.filter((name): name is string => typeof name === "string" && !CAP_EXEMPT.test(name));
}

/**
 * Why a new sandbox named `name` may not start, or "" when it may: the cap counts builders, runner sessions and schedule
 * ticks alike. A name already listed is a reuse, not a new sandbox. A failed list is left to the create step to report.
 */
export async function sandboxCapRefusal({ openshell, env, name = "" }: { openshell: string; env?: Env; name?: string }): Promise<string> {
  const list = await runTool(openshell, ["sandbox", "list", "-o", "json"], { env });
  if (list.code !== 0) return "";
  let names: unknown[];
  try { names = parseSandboxList(list.stdout).map((s) => s?.name); } catch { return ""; }
  if (name && names.includes(name)) return "";
  const counted = countedSandboxes(names);
  const cap = maxSandboxes(env);
  return counted.length >= cap ? `${counted.length} OpenShell sandboxes are running (${counted.join(", ")}); the cap is ${cap} (defaults.json maxSandboxes)` : "";
}

/**
 * The Claude and Codex login files a sandbox gets, found as lib/builder.mjs finds them: Claude's
 * `$CLAUDE_CONFIG_DIR/.credentials.json` (default ~/.claude), Codex's `$CODEX_HOME/auth.json`, else ~/.codex/auth.json.
 */
export function harnessLogins(env: Env = process.env, home = env.HOME || homedir(), remoteHome = HOME_IN): { harness: string; file: string; remoteDir: string }[] {
  const claude = join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), ".credentials.json");
  const codex = [join(env.CODEX_HOME || join(home, ".codex"), "auth.json"), join(home, ".codex", "auth.json")].find((file) => existsSync(file));
  return [
    ...(existsSync(claude) ? [{ harness: "claude", file: claude, remoteDir: `${remoteHome}/.claude` }] : []),
    ...(codex ? [{ harness: "codex", file: codex, remoteDir: `${remoteHome}/.codex` }] : []),
  ];
}

/** Copies one secret in through a 0600 temp file, so it never appears in argv, env or a log. */
export async function uploadSecret({ openshell, env, sandbox, file, remoteDir, name = basename(file), tmpPrefix = "ai-collab-sandbox-secret-" }: { openshell: string; env?: Env; sandbox: string; file: string; remoteDir: string; name?: string; tmpPrefix?: string }): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), tmpPrefix));
  try {
    writeFileSync(join(dir, name), readFileSync(file), { mode: 0o600 });
    return await uploadFile({ openshell, env, sandbox, local: join(dir, name), remoteDir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Copies the host's Claude and Codex logins into a sandbox home; a failed copy is logged, never fatal. Returns the harnesses copied. */
export async function uploadLogins({ openshell, env, sandbox, home, remoteHome, log = () => {} }: { openshell: string; env?: Env; sandbox: string; home?: string; remoteHome: string; log?: (line: string) => void }): Promise<string[]> {
  const copied: string[] = [];
  for (const login of harnessLogins(env, home, remoteHome)) {
    try {
      await uploadSecret({ openshell, env, sandbox, file: login.file, remoteDir: login.remoteDir });
      copied.push(login.harness);
    } catch (error) {
      log(`could not copy the ${login.harness} login into ${sandbox}: ${(error as Error).message.split("\n")[0]}`);
    }
  }
  return copied;
}

/** The host's ntfy token file from defaults.json, or "". */
export function hostTokenFile(env: Env = process.env): string {
  const file = (autoDefaults(env) as { tokenFile?: unknown } | null)?.tokenFile;
  return typeof file === "string" && existsSync(file) ? file : "";
}

/** Regular executable files directly in a directory: the binaries a network policy names. */
export function executables(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => { const st = statSync(join(dir, f)); return st.isFile() && (st.mode & 0o111) !== 0; });
  } catch { return []; }
}

/** The SHA-256 of a file, or "" when it cannot be read. */
export function fileHash(file: string): string {
  try { return createHash("sha256").update(readFileSync(file)).digest("hex"); } catch { return ""; }
}

/**
 * Uploads the staged tree in the order builders and scheduled runs share; each caller's optional steps are the fields
 * it sets (npm and logins). Returns the SHA-256 of the uploaded credentials file, or "".
 */
export async function stageAndUpload(a: UploadArgs): Promise<{ authHash: string }> {
  const { openshell, env, sandbox, log, staged, layout, style } = a;
  const common = { openshell, env, sandbox };
  await uploadAll({ ...common, local: staged.clone, remote: WORK, ...style });
  await uploadAll({ ...common, local: staged.tools, remote: SANDBOX, ...style });
  await uploadAll({ ...common, local: staged.home, remote: SANDBOX, ...style });
  if (staged.gitCore) await uploadAll({ ...common, local: staged.gitCore, remote: TOOLS, ...style });
  if (staged.node) await uploadFile({ ...common, local: staged.node, remoteDir: `${TOOLS}/node/bin` });
  if (staged.npm) await uploadAll({ ...common, local: staged.npm, remote: `${TOOLS}/node/lib/node_modules`, ...style });
  if (layout.file) await uploadFile({ ...common, local: layout.tree, remoteDir: layout.dir });
  else await uploadAll({ ...common, local: layout.tree, remote: layout.dir, ...style });
  let authHash = "";
  if (layout.auth) {
    await uploadSecret({ ...common, file: layout.auth, remoteDir: layout.authDir, tmpPrefix: a.secretTmp });
    authHash = fileHash(layout.auth);
  } else log(a.authMissing);
  if (a.logins) await uploadLogins({ ...common, home: a.logins.home, remoteHome: a.logins.remoteHome, log });
  if (staged.ntfyToken) await uploadSecret({ ...common, file: staged.ntfyToken, remoteDir: dirname(NTFY_TOKEN_IN), name: basename(NTFY_TOKEN_IN), tmpPrefix: a.secretTmp });
  if (staged.nodeModules) {
    await uploadAll({ ...common, local: staged.nodeModules, remote: DEPS, ...style });
    await must(openshell, execArgv({ openshell, sandbox, command: ["ln", "-sfn", `${DEPS}/${basename(staged.nodeModules)}`, `${staged.workdir}/node_modules`] }).slice(1), { env, timeoutMs: UPLOAD_TIMEOUT_MS, what: "sandbox exec ln", ...style });
  }
  return { authHash };
}

/** Commits loose work in a downloaded clone when it has any; returns whether it committed. */
export async function commitUncommitted({ git, repo, message, trailer }: { git: GitRunner; repo: string; message: string; trailer?: string }): Promise<boolean> {
  if (!(await git(repo, ["status", "--porcelain"])).trim()) return false;
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "--quiet", "--no-verify", "-m", message, ...(trailer ? ["-m", trailer] : [])]);
  return true;
}

/** The commits a clone has on top of its base. */
export async function commitsAhead({ git, repo, base }: { git: GitRunner; repo: string; base: string }): Promise<number> {
  return Number((await git(repo, ["rev-list", "--count", `${base}..HEAD`])).trim()) || 0;
}

/**
 * Downloads the clone, commits loose work, and fetches new commits into cwd's repo as sandbox/<name>-<stamp>; returns that branch or "".
 */
export async function landBranch({ openshell, env, sandbox, cwd, name, workdir, base, dir, log, now = Date.now() }: {
  openshell: string; env: Env; sandbox: string; cwd: string; name: string; workdir: string; base: string; dir: string; log: (line: string) => void; now?: number;
}): Promise<string> {
  const git = gitIn(env);
  await runTool(openshell, execArgv({ openshell, sandbox, command: ["rm", "-f", `${workdir}/node_modules`] }).slice(1), { env });
  const back = join(dir, "back", basename(cwd));
  mkdirSync(dirname(back), { recursive: true });
  await downloadTree({ openshell, env, sandbox, remote: workdir, local: back, timeoutMs: UPLOAD_TIMEOUT_MS, errorPrefix: "", stdoutFallback: true });
  if (!existsSync(join(back, ".git"))) throw new Error("the downloaded workspace has no git repository");
  await commitUncommitted({ git, repo: back, message: `chore(sandbox): uncommitted work from schedule ${name}` });
  const ahead = await commitsAhead({ git, repo: back, base });
  if (!ahead) { log("no new commits"); return ""; }
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const target = `sandbox/${name}-${stamp}`;
  await git(cwd, ["fetch", "--quiet", back, `HEAD:refs/heads/${target}`]);
  log(`${ahead} commit(s) on branch ${target} in ${cwd}`);
  return target;
}
