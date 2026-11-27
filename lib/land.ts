// Landing through GitHub PRs: list and merge green PRs, and deploy origin/main to the host checkout.
// gh and git run through an injected `run(file, argv, options)` that resolves {status, stdout, stderr}.
import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { stateDir } from "./config.ts";
import { findExecutable } from "./sessions/scope.ts";
import { reviewPacket, TITLE_MAX } from "./tasks.ts";
import type { RunResult } from "./deploy-tree.ts";

export const PR_FIELDS = "number,title,url,headRefName,headRefOid,additions,deletions,statusCheckRollup";
export const SERVICES = ["ai-collab-bus", "ai-collab-ui", "ai-collab-runner"];
const SHA = /^[0-9a-f]{40}$/;
const SHORT = 12;
const AUTO_DEPLOY_EVERY_MS = 5 * 60_000;
// A kill mid-install breaks node_modules on the host, so the cap leaves room for npm ci and the build.
export const AUTO_DEPLOY_TIMEOUT_MS = 20 * 60_000;
// oxlint-disable-next-line quality/no-known-value-widening -- looked up by a runtime check state
const CHECK_WORDS: Record<string, string> = { failure: "failing", pending: "pending", none: "missing" };

// oxlint-disable-next-line typescript/no-explicit-any -- gh prints JSON; the deploy record is JSON on disk
type Json = any;
type Env = NodeJS.ProcessEnv;
type RunOptions = { cwd?: string; env?: Env; encoding?: "utf8" };
/** Runs a command to completion; tests inject a fake for git, gh, npm and systemd-run. */
export type LandRun = (file: string, argv: string[], options?: RunOptions) => Promise<RunResult>;
type DeployedField = { deployed?: string };
type RunScope = { run?: LandRun; cwd?: string };
/** An open PR into main as the UI lists it. */
export type OpenPr = { number: number; title: string; url: string; branch: string; headSha: string; additions: number; deletions: number; checks: string };
/** What deployHost reports; line is the one-line summary the CLI prints. */
export type DeployResult = { status: "deployed" | "skipped" | "failed" | "unchanged"; reason?: string; line?: string; built?: false; from?: string; to?: string };
type TaskBackend = {
  add: (fields: { title: string }, now: number) => Promise<{ id: string }>;
  submitReview: (id: string, packet: Json, now: number) => Promise<Json>;
};
type FinishOptions = { landing?: string; proof?: string; run?: LandRun; cwd?: string; tasks?: TaskBackend; task?: string; by?: string; now?: number };
type DeployOptions = {
  run?: LandRun; hostCheckout?: string; env?: Env; ifMoved?: boolean; nodePath?: string; npm?: string[]; deployed?: string;
  build?: string[]; returning?: boolean; check?: () => Promise<string | null>;
};

export const HOST_CHECKOUT = "/home/b/ai-collab";
// The UI deploy step: publishes the build and verifies the served build (deploy/build-ui.mjs).
export const UI_DEPLOY_ARGS = ["run", "build", "--", "--deploy-and-verify"];

export const BRANCH = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;
export const LANDING_POLICIES = ["pr", "packet", "branch"];
const GITHUB_REMOTE = /^(https:\/\/github\.com\/|git@github\.com:)/;
const PROOF_CLIP = 400;
const PR_BODY_MAX = 60_000;

// The npm to run for a Node install: its bundled npm, else the npm on PATH.
export function npmCommand(node: string, path: string | undefined): string[] {
  const npmCli = bundledNpm(node);
  const [npm, ...npmArgs] = existsSync(npmCli) ? [node, npmCli] : [findExecutable("npm", path)];
  if (!npm) throw new Error(`npm was not found for Node at ${node}`);
  return [npm, ...npmArgs];
}

function bundledNpm(node: string): string {
  return join(dirname(node), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
}

export function mergeNode(nodePath: string, cwd: string, env: Env): string {
  const node = realpathSync(nodePath);
  if (existsSync(bundledNpm(node))) return node;
  const mise = findExecutable("mise", env.PATH || "");
  if (!mise) return node;
  // Cursor carries Node without npm. Resolve the installation before replacing HOME.
  const result = spawnSync(mise, ["which", "node"], { cwd, env, encoding: "utf8" });
  const installed = result.stdout?.trim();
  if (result.status !== 0 || !installed || !isAbsolute(installed) || !existsSync(installed)) return node;
  const resolved = realpathSync(installed);
  return existsSync(bundledNpm(resolved)) ? resolved : node;
}

export class LandRefused extends Error {}

/** The default run: execFile resolving {status, stdout, stderr}; rejects only when the file cannot start. */
export function execRun(file: string, argv: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(file, argv, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error && typeof error.code === "string") return reject(error);
      resolve({ status: error ? (error.code as number | undefined) ?? null : 0, stdout, stderr });
    });
  });
}

const lastLine = (text = ""): string => text.trim().split("\n").pop() ?? "";
const logSubjects = (out = ""): string[] => out.split("\n").map((line) => line.trim()).filter(Boolean);

async function gh(run: LandRun, cwd: string, argv: string[]): Promise<string> {
  const result = await run("gh", argv, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`gh ${argv.slice(0, 2).join(" ")} failed: ${lastLine(result.stderr) || `exit ${result.status}`}`);
  return result.stdout.trim();
}

// One check: a CheckRun has a status; a StatusContext has a state. Only SUCCESS counts as green.
function checkOutcome(check: Json): string {
  if ("status" in check) {
    if (check.status !== "COMPLETED") return "pending";
    return check.conclusion === "SUCCESS" ? "success" : "failure";
  }
  if (check.state === "SUCCESS") return "success";
  return check.state === "PENDING" || check.state === "EXPECTED" ? "pending" : "failure";
}

/** success only when every check succeeded; none when the PR reports no checks. */
export function checkState(rollup: Json[] = []): string {
  const outcomes = rollup.map(checkOutcome);
  if (!outcomes.length) return "none";
  if (outcomes.includes("failure")) return "failure";
  return outcomes.includes("pending") ? "pending" : "success";
}

const toPr = (pr: Json): OpenPr => ({
  number: pr.number, title: pr.title, url: pr.url, branch: pr.headRefName, headSha: pr.headRefOid,
  additions: pr.additions, deletions: pr.deletions, checks: checkState(pr.statusCheckRollup),
});

/** Open PRs into main, each with its check state. */
export async function listOpenPrs({ run = execRun, cwd = HOST_CHECKOUT }: RunScope = {}): Promise<OpenPr[]> {
  const prs: Json[] = JSON.parse(await gh(run, cwd, ["pr", "list", "--state", "open", "--base", "main", "--limit", "50", "--json", PR_FIELDS]));
  return prs.map(toPr);
}

/** Pushes branch (never main) and returns its open PR into main, creating one when none is open. */
export async function requestLand(branch: string, { run = execRun, cwd = process.cwd() }: RunScope = {}): Promise<{ url: string; created: boolean }> {
  if (!BRANCH.test(branch) || branch === "main") throw new LandRefused(`refusing to land ${branch}`);
  const pushed = await run("git", ["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`], { cwd, encoding: "utf8" });
  if (pushed.status !== 0) throw new Error(`git push ${branch} failed: ${lastLine(pushed.stderr) || `exit ${pushed.status}`}`);
  const open = JSON.parse(await gh(run, cwd, ["pr", "list", "--head", branch, "--base", "main", "--state", "open", "--json", "url", "--limit", "1"]));
  if (open.length) return { url: open[0].url, created: false };
  const url = lastLine(await gh(run, cwd, ["pr", "create", "--base", "main", "--head", branch, "--fill"]));
  return { url, created: true };
}

/** Whether this checkout can land through GitHub: origin is on github.com and gh is signed in there. */
export async function githubReady({ run = execRun, cwd = process.cwd() }: RunScope = {}): Promise<boolean> {
  const remote = await run("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" });
  if (remote.status !== 0 || !GITHUB_REMOTE.test(remote.stdout.trim())) return false;
  const auth = await run("gh", ["auth", "status", "--hostname", "github.com"], { cwd, encoding: "utf8" });
  return auth.status === 0;
}

// The draft PR body: the branch's commit subjects, then the session proof fenced as text.
function prBody({ subjects, proof }: { subjects: string[]; proof: string }): string {
  const commits = subjects.map((subject) => `- ${subject}`).join("\n");
  const body = `## Commits\n${commits}\n\n## Proof\n\n\`\`\`text\n${proof.trim() || "No proof supplied."}\n\`\`\`\n`;
  return body.slice(0, PR_BODY_MAX);
}

/** Finishes branch as a draft PR ("pr"), a review packet ("packet") or a bare push ("branch"); defaults to pr when githubReady, else packet. */
export async function finishBranch(branch: string, { landing, proof = "", run = execRun, cwd = process.cwd(), tasks, task, by = "cli", now = Date.now() }: FinishOptions = {}): Promise<Json> {
  if (!BRANCH.test(branch) || branch === "main") throw new LandRefused(`refusing to land ${branch}`);
  if (landing !== undefined && !LANDING_POLICIES.includes(landing)) throw new LandRefused(`unknown landing policy ${landing}`);
  const git = async (...argv: string[]): Promise<string> => {
    const result = await run("git", argv, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${argv.join(" ")} failed: ${lastLine(result.stderr) || `exit ${result.status}`}`);
    return result.stdout;
  };
  const push = async () => {
    const pushed = await run("git", ["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`], { cwd, encoding: "utf8" });
    if (pushed.status !== 0) throw new Error(`git push ${branch} failed: ${lastLine(pushed.stderr) || `exit ${pushed.status}`}`);
  };
  if (landing === "branch") {
    await push();
    return { landing: "branch", branch };
  }
  const ready = await githubReady({ run, cwd });
  if (landing === "pr" && !ready) throw new LandRefused("landing=pr needs a GitHub origin and a signed-in gh");
  if ((landing ?? (ready ? "pr" : "packet")) === "pr") {
    await push();
    const open = JSON.parse(await gh(run, cwd, ["pr", "list", "--head", branch, "--base", "main", "--state", "open", "--json", "url", "--limit", "1"]));
    if (open.length) return { landing: "pr", url: open[0].url, created: false };
    const title = lastLine(await git("log", "-1", "--format=%s", `refs/heads/${branch}`));
    const commits = logSubjects(await git("log", "--format=%s", `refs/remotes/origin/main..refs/heads/${branch}`));
    const url = lastLine(await gh(run, cwd, ["pr", "create", "--draft", "--base", "main", "--head", branch, "--title", title, "--body", prBody({ subjects: commits, proof })]));
    return { landing: "pr", url, created: true };
  }
  const commit = lastLine(await git("rev-parse", "--verify", `refs/heads/${branch}^{commit}`));
  const remoteBase = await run("git", ["merge-base", "refs/remotes/origin/main", `refs/heads/${branch}`], { cwd, encoding: "utf8" });
  const base = remoteBase.status === 0 ? lastLine(remoteBase.stdout) : lastLine(await git("merge-base", "refs/heads/main", `refs/heads/${branch}`));
  const commits = logSubjects(await git("log", "--format=%s", `${base}..${commit}`));
  const packet = reviewPacket({
    submission: randomUUID(), commit, base, branch, criteria: commits,
    check: { code: 2, text: `not run by the host; session proof: ${proof.trim().slice(0, PROOF_CLIP).replace(/[\r\n]+/g, " | ")}` },
    numstat: await git("diff", "--numstat", `${base}..${commit}`),
    at: now,
  });
  const id = task ?? (await (tasks as TaskBackend).add({ title: `Review ${branch}: ${commits[0] ?? ""}`.trim().slice(0, TITLE_MAX) }, now)).id;
  await (tasks as TaskBackend).submitReview(id, packet, now);
  return { landing: "packet", task: id };
}

/** Merges PR number at headSha when every check succeeded; --match-head-commit refuses a head pushed since the operator looked. */
export async function mergePr(number: number, headSha: string, { run = execRun, cwd = HOST_CHECKOUT }: RunScope = {}): Promise<{ merged: true; number: number }> {
  if (!Number.isInteger(number) || number < 1 || !SHA.test(headSha)) throw new LandRefused("Give the PR number and its head commit");
  const pr: Json = JSON.parse(await gh(run, cwd, ["pr", "view", String(number), "--json", "state,headRefOid,statusCheckRollup"]));
  if (pr.state !== "OPEN") throw new LandRefused(`#${number} is ${pr.state.toLowerCase()}`);
  if (pr.headRefOid !== headSha) throw new LandRefused(`#${number} moved after you looked; reload and check its checks`);
  const checks = checkState(pr.statusCheckRollup);
  if (checks !== "success") throw new LandRefused(`#${number} checks are ${CHECK_WORDS[checks]}`);
  await gh(run, cwd, ["pr", "merge", String(number), "--merge", "--match-head-commit", headSha]);
  return { merged: true, number };
}

/**
 * Pulls the host checkout to origin/main, then installs dependencies and runs build (default: the UI deploy step).
 * returning (back from another tree) deploys an unmoved HEAD; check runs before npm and a reason it returns skips.
 * Returns {status: "deployed" | "skipped" | "failed" | "unchanged", line}; ifMoved returns "unchanged" when the last shipped commit (else HEAD) matches origin/main.
 * deployed is the commit the last deploy shipped: with it, a HEAD that a manual pull already moved still deploys.
 */
export async function deployHost({
  run = execRun, hostCheckout = HOST_CHECKOUT, env = process.env, ifMoved = false, nodePath = process.execPath, npm, deployed,
  build = UI_DEPLOY_ARGS, returning = false, check = async () => null,
}: DeployOptions = {}): Promise<DeployResult> {
  const git = (...argv: string[]) => run("git", argv, { cwd: hostCheckout, encoding: "utf8" });
  const revParse = async (ref: string): Promise<string> => (await git("rev-parse", ref)).stdout.trim();
  const skip = (reason: string): DeployResult => ({ status: "skipped", reason, line: `skipped: ${reason}` });
  if (ifMoved) {
    const fetched = await git("fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main");
    if (fetched.status !== 0) return { status: "failed", reason: "fetch origin main", line: "failed: fetch origin main" };
    if ((deployed ?? await revParse("HEAD")) === await revParse("refs/remotes/origin/main")) return { status: "unchanged" };
  }
  const branch = (await git("symbolic-ref", "--short", "HEAD")).stdout.trim();
  if (branch !== "main") return skip(`the host checkout is on ${branch || "no branch"}, not on main`);
  if ((await git("status", "--porcelain", "--untracked-files=no")).stdout.trim()) return skip("the host checkout has local changes");
  const before = deployed ?? await revParse("HEAD");
  const pull = await git("pull", "--ff-only");
  if (pull.status !== 0) return skip(`git pull --ff-only: ${lastLine(pull.stderr || pull.stdout) || `exit ${pull.status}`}`);
  const after = await revParse("HEAD");
  // Returning from another tree with main already built: point back without a rebuild.
  if (returning && after === deployed) return { status: "deployed", built: false, from: before, to: after, line: `deployed main ${after.slice(0, SHORT)}` };
  if (after === before && !returning) return skip(`HEAD unchanged at ${before.slice(0, SHORT)}`);
  const held = await check();
  if (held) return skip(held);
  const [npmFile, ...npmArgs] = npm ?? npmCommand(mergeNode(nodePath, hostCheckout, env), env.PATH);
  const npmRun = (argv: string[]) => run(npmFile, [...npmArgs, ...argv], { cwd: hostCheckout, env, encoding: "utf8" });
  const ci = await npmRun(["ci", "--include=dev"]);
  if (ci.status !== 0) return { status: "failed", from: before, to: after, line: `failed: npm ci --include=dev exited ${ci.status}` };
  const built = await npmRun(build);
  if (built.status !== 0) return { status: "failed", from: before, to: after, line: `failed: UI deploy exited ${built.status}` };
  return { status: "deployed", from: before, to: after, line: `deployed ${before.slice(0, SHORT)}..${after.slice(0, SHORT)}` };
}

/** Restarts services (default: bus, UI and runner) as one transient unit, so restarting the runner does not stop this command. */
export function restartServices({ run = execRun, stamp = Date.now(), services = SERVICES }: { run?: LandRun; stamp?: number; services?: string[] } = {}): Promise<RunResult> {
  return run("systemd-run", ["--user", "--collect", `--unit=ai-collab-restart-${stamp}`, "systemctl", "--user", "restart", ...services], { encoding: "utf8" });
}

/** Starts `ai-collab deploy` detached as its own transient unit and returns once systemd has started it. */
export async function startDeploy({ run = execRun, nodePath = process.execPath, hostCheckout = HOST_CHECKOUT, stamp = Date.now() }: { run?: LandRun; nodePath?: string; hostCheckout?: string; stamp?: number } = {}): Promise<RunResult> {
  const result = await run("systemd-run", ["--user", "--collect", `--unit=ai-collab-deploy-${stamp}`, nodePath, join(hostCheckout, "scripts/ai-collab.mjs"), "deploy"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`systemd-run failed: ${lastLine(result.stderr) || `exit ${result.status}`}`);
  return result;
}

/** The runner schedule that runs `deploy --if-moved` every 5 minutes. */
export function autoDeployEntry({ nodePath = process.execPath, hostCheckout = HOST_CHECKOUT }: { nodePath?: string; hostCheckout?: string } = {}) {
  return {
    name: "auto-deploy", everyMs: AUTO_DEPLOY_EVERY_MS, cwd: hostCheckout, timeoutMs: AUTO_DEPLOY_TIMEOUT_MS,
    command: [nodePath, join(hostCheckout, "scripts/ai-collab.mjs"), "deploy", "--if-moved"],
  };
}

const lastDeployPath = (env: Env): string => join(stateDir(env), "deploy-last.json");

/** The last deploy result the CLI recorded, or null before any deploy. */
export function readLastDeploy(env: Env = process.env): Json {
  try {
    return JSON.parse(readFileSync(lastDeployPath(env), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function writeLastDeploy(env: Env, record: Json): void {
  mkdirSync(stateDir(env), { recursive: true });
  writeFileSync(lastDeployPath(env), `${JSON.stringify(record)}\n`);
}

/** {deployed: ref} while a tree other than main serves the services, else {}; an unreadable record counts as main. */
export function deployedField(env: Env = process.env): DeployedField {
  let ref: unknown;
  try { ref = readLastDeploy(env)?.ref; } catch { return {}; }
  return typeof ref === "string" && ref && ref !== "main" ? { deployed: ref } : {};
}

/** The UI's adapter: the host's gh and systemd calls. */
export const hostLand = {
  list: () => listOpenPrs(),
  merge: (number: number, headSha: string) => mergePr(number, headSha),
  startDeploy: () => startDeploy(),
  lastDeploy: (env?: Env) => readLastDeploy(env),
};
