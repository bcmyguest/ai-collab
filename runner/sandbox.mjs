// OpenShell sandboxes for owned sessions: one per project, reused, deleted when its last session closes.
//
// Verified against openshell 0.1.9 on 2026-11-22 (docs/owned-sessions-contract.md, OpenShell section):
//   - `sandbox create --name N --no-tty --detach --policy P` returns when the sandbox is Ready.
//   - `sandbox upload N <dir>/ <dest>/` copies <dir> into <dest>/<basename>; the trailing slash on
//     both is required (a DEST with no trailing slash nests the tree one level deeper). Inside a Git
//     work tree openshell drops .gitignore matches and refuses an upload when that leaves nothing;
//     uploadTree retries with --no-git-ignore then.
//   - `sandbox exec --no-tty -n N --workdir D --env K=V -- <cmd>` runs one command; stdin and
//     stdout are the only channel to it, so ACP over stdio works through it unchanged. Env pairs
//     come before --workdir. A login shell rewrites PATH; exec does not, so the caller's PATH holds.
//   - `sandbox download N <remote> <local>` merges the remote tree into <local> (host-only files stay).
//   - `sandbox delete N` removes the sandbox and its containers; `sandbox list` is then empty.
//   - SIGTERM to the local `exec` client does stop the remote command; only a process that detached
//     itself (nohup ... &) survives, and the sandbox delete is what ends that one.
//   - There is no host bind mount: the docker driver mounts only its own channel volume and
//     refuses raw bind mounts while resource admission is on, and caller driver_config is off by
//     default. Sync is upload before the run and download after it.
//   - Egress is policy-brokered: a network policy must name the host and the real path of the
//     binary that connects (`readlink -f`), and only hostnames route. `host.openshell.internal`
//     is the host itself, so the ntfy server on 127.0.0.1:8794 is reachable there and nowhere else.
//   - The image (nvcr.io/nvidia/base/ubuntu:24.04) has no /etc/ssl and no node on PATH; both come
//     from the uploaded CLI tree.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { autoDefaults } from "../lib/config.mjs";

const SETUP_TIMEOUT_MS = 60_000;
const SYNC_TIMEOUT_MS = 600_000;
const SANDBOX_NAME_MAX = 19;
// The cap on OpenShell sandboxes when defaults.json names no maxSandboxes (operator decision 2026-11-23).
export const DEFAULT_MAX_SANDBOXES = 6;
// Outside the cap: run_code's shared sandbox and its per-call read sandboxes (lib/code-run.mjs), short-lived tool plumbing.
const CAP_EXEMPT = /^(ai-collab-code$|aic-ro-)/;

/** Lowercase DNS-label-safe sandbox name for a project. */
export function sandboxName(project) {
  const slug = String(project).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const name = `ai-collab-${slug}`;
  if (slug && name.length <= SANDBOX_NAME_MAX) return name;
  const suffix = createHash("sha256").update(String(project)).digest("hex").slice(0, 8);
  return `ai-collab-${suffix}`;
}

/** The sandbox a team run's OpenShell members share: team-<14 hex of project/run>. */
export function teamSandboxName(project, run) {
  return "team-" + createHash("sha256").update(project + "/" + run).digest("hex").slice(0, 14);
}

/** The phase a sandbox JSON record reports; 0.1.9 writes "Ready" on `sandbox get` and `sandbox list`. */
export function sandboxPhase(sandbox) {
  return String(sandbox?.phase ?? sandbox?.state ?? sandbox?.status?.phase ?? sandbox?.status ?? "");
}

/** The start/resume step for a sandbox in a non-ready phase, or null when it needs none. */
export function stateCommand(name, phase) {
  if (/suspend/i.test(phase)) return ["resume", name];
  if (/stop|exited|terminated/i.test(phase)) return ["start", name];
  return null;
}

/** Argv that runs a command in a sandbox; env pairs come first, then `--workdir`, then the command. */
export function execArgv({ openshell, sandbox, workdir, env = {}, command }) {
  return [
    openshell, "sandbox", "exec", "--no-tty", "-n", sandbox,
    ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    ...(workdir ? ["--workdir", workdir] : []),
    "--", ...command,
  ];
}

/** Argv that copies a host directory into a sandbox; both paths end in "/" so the basename is kept. */
export function uploadArgv({ openshell, sandbox, local, remote }) {
  return [openshell, "sandbox", "upload", sandbox, `${local.replace(/\/+$/, "")}/`, `${remote.replace(/\/+$/, "")}/`];
}

/** Argv that copies a sandbox path back to the host. */
export function downloadArgv({ openshell, sandbox, remote, local }) {
  return [openshell, "sandbox", "download", sandbox, remote, local];
}

/** Runs a short-lived tool to completion; never rejects, so a missing binary reports through `stderr`. */
export function runTool(bin, args, { env, cwd, timeoutMs = SETUP_TIMEOUT_MS, stdin } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env, cwd, shell: false, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    if (stdin !== undefined) { child.stdin.on("error", () => {}); child.stdin.end(stdin); }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** Parses `openshell sandbox list -o json`; throws when the reply is not JSON. */
export function parseSandboxList(stdout) {
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { throw new Error("openshell sandbox list printed no JSON"); }
  return Array.isArray(parsed?.sandboxes) ? parsed.sandboxes : [];
}

/**
 * Lists sandboxes once, then creates the named one when it is missing, starts or resumes it when its
 * phase says so. Throws an Error whose message the operator can act on; never prints a secret.
 */
export async function ensureSandbox({ openshell, env, name, policy, recreateBroken = false }) {
  const list = await runTool(openshell, ["sandbox", "list", "-o", "json"], { env });
  if (list.code !== 0) throw new Error(`openshell sandbox list failed: ${list.stderr.trim() || `exit ${list.code}`}`);
  let found = parseSandboxList(list.stdout).find((s) => s?.name === name);
  // A sandbox in Error never becomes ready; a caller whose sandbox holds no work (run_code) replaces it.
  if (found && recreateBroken && /error|fail/i.test(sandboxPhase(found))) {
    await mustRun(openshell, ["sandbox", "delete", name], { env, timeoutMs: SYNC_TIMEOUT_MS }, "sandbox delete");
    found = null;
  }
  if (found) {
    const step = stateCommand(name, sandboxPhase(found));
    if (!step) return name;
    await mustRun(openshell, ["sandbox", ...step], { env }, `sandbox ${step[0]}`);
    return name;
  }
  await mustRun(openshell, [
    "sandbox", "create", "--name", name, "--no-tty", "--detach",
    ...(policy ? ["--policy", policy] : []),
  ], { env, timeoutMs: SYNC_TIMEOUT_MS }, "sandbox create");
  return name;
}

/** Runs a sandbox command, turning a non-zero exit into an actionable error. */
async function mustRun(openshell, args, { env, timeoutMs }, what) {
  const out = await runTool(openshell, args, { env, timeoutMs });
  if (out.code !== 0) throw new Error(`openshell ${what} failed: ${out.stderr.trim() || `exit ${out.code}`}`);
  return out;
}

/** Uploads a host directory into a sandbox; the directory's basename becomes the last path segment. */
export async function uploadTree({ openshell, env, sandbox, local, remote, gitIgnore = true }) {
  const args = uploadArgv({ openshell, sandbox, local, remote }).slice(1);
  if (!gitIgnore) args.push("--no-git-ignore");
  const out = await runTool(openshell, args, { env, timeoutMs: SYNC_TIMEOUT_MS });
  // Inside a work tree openshell drops .gitignore matches, and a tree with no tracked files uploads nothing.
  if (gitIgnore && out.code !== 0 && /Git filtering selected no files/i.test(out.stderr)) {
    return mustRun(openshell, [...args.slice(0, 2), "--no-git-ignore", ...args.slice(2)], { env, timeoutMs: SYNC_TIMEOUT_MS }, "sandbox upload");
  }
  if (out.code !== 0) throw new Error(`openshell sandbox upload failed: ${out.stderr.trim() || `exit ${out.code}`}`);
  return out;
}

/** Uploads one host file into a sandbox directory; a trailing slash on the directory keeps the file's own name. */
export async function uploadFile({ openshell, env, sandbox, local, remoteDir }) {
  const dest = `${remoteDir.replace(/\/+$/, "")}/`;
  return mustRun(openshell, ["sandbox", "upload", sandbox, local, dest], { env, timeoutMs: SYNC_TIMEOUT_MS }, "sandbox upload");
}

/** Downloads a sandbox path to a host path. */
export async function downloadTree({ openshell, env, sandbox, remote, local }) {
  return mustRun(openshell, downloadArgv({ openshell, sandbox, remote, local }).slice(1), { env, timeoutMs: SYNC_TIMEOUT_MS }, "sandbox download");
}

/** Deletes a sandbox; never throws, so a failed cleanup cannot mask the session's own error. */
export async function destroySandbox({ openshell, env, name }) {
  const out = await runTool(openshell, ["sandbox", "delete", name], { env, timeoutMs: SYNC_TIMEOUT_MS });
  return { ok: out.code === 0, detail: (out.stderr || out.stdout).trim() };
}

/** Names of sandboxes this runner owns for a project. */
export function ownedSandboxNames(project) {
  return [sandboxName(project)];
}

/** The sandbox cap: defaults.json maxSandboxes when a positive integer, else DEFAULT_MAX_SANDBOXES. */
export function maxSandboxes(env = process.env) {
  const value = autoDefaults(env)?.maxSandboxes;
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_SANDBOXES;
}

/** The sandbox names the cap counts: every one but run_code's. */
export function countedSandboxes(names) {
  return names.filter((name) => typeof name === "string" && !CAP_EXEMPT.test(name));
}

/**
 * Why a new sandbox named `name` may not start, or "" when it may: the cap counts builders, runner sessions and schedule
 * ticks alike. A name already listed is a reuse, not a new sandbox. A failed list is left to the create step to report.
 */
export async function sandboxCapRefusal({ openshell, env, name = "" }) {
  const list = await runTool(openshell, ["sandbox", "list", "-o", "json"], { env });
  if (list.code !== 0) return "";
  let names;
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
export function harnessLogins(env = process.env, home = env.HOME || homedir(), remoteHome = "/sandbox/home") {
  const claude = join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), ".credentials.json");
  const codex = [join(env.CODEX_HOME || join(home, ".codex"), "auth.json"), join(home, ".codex", "auth.json")].find((file) => existsSync(file));
  return [
    ...(existsSync(claude) ? [{ harness: "claude", file: claude, remoteDir: `${remoteHome}/.claude` }] : []),
    ...(codex ? [{ harness: "codex", file: codex, remoteDir: `${remoteHome}/.codex` }] : []),
  ];
}

/** Copies one secret in through a 0600 temp file, so it never appears in argv, env or a log. */
export async function uploadSecret({ openshell, env, sandbox, file, remoteDir, name = basename(file) }) {
  const dir = mkdtempSync(join(tmpdir(), "ai-collab-sandbox-secret-"));
  try {
    writeFileSync(join(dir, name), readFileSync(file), { mode: 0o600 });
    return await uploadFile({ openshell, env, sandbox, local: join(dir, name), remoteDir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Copies the host's Claude and Codex logins into a sandbox home; a failed copy is logged, never fatal. Returns the harnesses copied. */
export async function uploadLogins({ openshell, env, sandbox, home, remoteHome, log = () => {} }) {
  const copied = [];
  for (const login of harnessLogins(env, home, remoteHome)) {
    try {
      await uploadSecret({ openshell, env, sandbox, file: login.file, remoteDir: login.remoteDir });
      copied.push(login.harness);
    } catch (error) {
      log(`could not copy the ${login.harness} login into ${sandbox}: ${error.message.split("\n")[0]}`);
    }
  }
  return copied;
}
