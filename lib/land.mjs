// Landing through GitHub PRs: list and merge green PRs, and deploy origin/main to the host checkout.
// gh and git run through an injected `run(file, argv, options)` that resolves {status, stdout, stderr}.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./config.mjs";
import { BRANCH, HOST_CHECKOUT, UI_DEPLOY_ARGS, mergeNode, npmCommand } from "./merge-cli.mjs";

export const PR_FIELDS = "number,title,url,headRefName,headRefOid,additions,deletions,statusCheckRollup";
export const SERVICES = ["ai-collab-bus", "ai-collab-ui", "ai-collab-runner"];
const SHA = /^[0-9a-f]{40}$/;
const SHORT = 12;
const AUTO_DEPLOY_EVERY_MS = 5 * 60_000;
// A kill mid-install breaks node_modules on the host, so the cap leaves room for npm ci and the build.
export const AUTO_DEPLOY_TIMEOUT_MS = 20 * 60_000;
const CHECK_WORDS = { failure: "failing", pending: "pending", none: "missing" };

export class LandRefused extends Error {}

/** The default run: execFile resolving {status, stdout, stderr}; rejects only when the file cannot start. */
export function execRun(file, argv, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, argv, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error && typeof error.code === "string") return reject(error);
      resolve({ status: error ? error.code ?? null : 0, stdout, stderr });
    });
  });
}

const lastLine = (text = "") => text.trim().split("\n").pop() ?? "";

async function gh(run, cwd, argv) {
  const result = await run("gh", argv, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`gh ${argv.slice(0, 2).join(" ")} failed: ${lastLine(result.stderr) || `exit ${result.status}`}`);
  return result.stdout.trim();
}

// One check: a CheckRun has a status; a StatusContext has a state. Only SUCCESS counts as green.
function checkOutcome(check) {
  if ("status" in check) {
    if (check.status !== "COMPLETED") return "pending";
    return check.conclusion === "SUCCESS" ? "success" : "failure";
  }
  if (check.state === "SUCCESS") return "success";
  return check.state === "PENDING" || check.state === "EXPECTED" ? "pending" : "failure";
}

/** success only when every check succeeded; none when the PR reports no checks. */
export function checkState(rollup = []) {
  const outcomes = rollup.map(checkOutcome);
  if (!outcomes.length) return "none";
  if (outcomes.includes("failure")) return "failure";
  return outcomes.includes("pending") ? "pending" : "success";
}

const toPr = (pr) => ({
  number: pr.number, title: pr.title, url: pr.url, branch: pr.headRefName, headSha: pr.headRefOid,
  additions: pr.additions, deletions: pr.deletions, checks: checkState(pr.statusCheckRollup),
});

/** Open PRs into main, each with its check state. */
export async function listOpenPrs({ run = execRun, cwd = HOST_CHECKOUT } = {}) {
  const prs = JSON.parse(await gh(run, cwd, ["pr", "list", "--state", "open", "--base", "main", "--limit", "50", "--json", PR_FIELDS]));
  return prs.map(toPr);
}

/** Pushes branch (never main) and returns its open PR into main, creating one when none is open. */
export async function requestLand(branch, { run = execRun, cwd = process.cwd() } = {}) {
  if (!BRANCH.test(branch) || branch === "main") throw new LandRefused(`refusing to land ${branch}`);
  const pushed = await run("git", ["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`], { cwd, encoding: "utf8" });
  if (pushed.status !== 0) throw new Error(`git push ${branch} failed: ${lastLine(pushed.stderr) || `exit ${pushed.status}`}`);
  const open = JSON.parse(await gh(run, cwd, ["pr", "list", "--head", branch, "--base", "main", "--state", "open", "--json", "url", "--limit", "1"]));
  if (open.length) return { url: open[0].url, created: false };
  const url = lastLine(await gh(run, cwd, ["pr", "create", "--base", "main", "--head", branch, "--fill"]));
  return { url, created: true };
}

/** Merges PR number at headSha when every check succeeded; --match-head-commit refuses a head pushed since the operator looked. */
export async function mergePr(number, headSha, { run = execRun, cwd = HOST_CHECKOUT } = {}) {
  if (!Number.isInteger(number) || number < 1 || !SHA.test(headSha)) throw new LandRefused("Give the PR number and its head commit");
  const pr = JSON.parse(await gh(run, cwd, ["pr", "view", String(number), "--json", "state,headRefOid,statusCheckRollup"]));
  if (pr.state !== "OPEN") throw new LandRefused(`#${number} is ${pr.state.toLowerCase()}`);
  if (pr.headRefOid !== headSha) throw new LandRefused(`#${number} moved after you looked; reload and check its checks`);
  const checks = checkState(pr.statusCheckRollup);
  if (checks !== "success") throw new LandRefused(`#${number} checks are ${CHECK_WORDS[checks]}`);
  await gh(run, cwd, ["pr", "merge", String(number), "--merge", "--match-head-commit", headSha]);
  return { merged: true, number };
}

/**
 * Pulls the host checkout to origin/main, then installs dependencies and runs the UI deploy step.
 * Returns {status: "deployed" | "skipped" | "failed" | "unchanged", line}; ifMoved returns "unchanged" when HEAD matches origin/main.
 */
export async function deployHost({ run = execRun, hostCheckout = HOST_CHECKOUT, env = process.env, ifMoved = false, nodePath = process.execPath, npm } = {}) {
  const git = (...argv) => run("git", argv, { cwd: hostCheckout, encoding: "utf8" });
  const revParse = async (ref) => (await git("rev-parse", ref)).stdout.trim();
  const skip = (reason) => ({ status: "skipped", reason, line: `skipped: ${reason}` });
  if (ifMoved) {
    const fetched = await git("fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main");
    if (fetched.status !== 0) return { status: "failed", reason: "fetch origin main", line: "failed: fetch origin main" };
    if (await revParse("HEAD") === await revParse("refs/remotes/origin/main")) return { status: "unchanged" };
  }
  const branch = (await git("symbolic-ref", "--short", "HEAD")).stdout.trim();
  if (branch !== "main") return skip(`the host checkout is on ${branch || "no branch"}, not on main`);
  if ((await git("status", "--porcelain", "--untracked-files=no")).stdout.trim()) return skip("the host checkout has local changes");
  const before = await revParse("HEAD");
  const pull = await git("pull", "--ff-only");
  if (pull.status !== 0) return skip(`git pull --ff-only: ${lastLine(pull.stderr || pull.stdout) || `exit ${pull.status}`}`);
  const after = await revParse("HEAD");
  if (after === before) return skip(`HEAD unchanged at ${before.slice(0, SHORT)}`);
  const [npmFile, ...npmArgs] = npm ?? npmCommand(mergeNode(nodePath, hostCheckout, env), env.PATH);
  const npmRun = (argv) => run(npmFile, [...npmArgs, ...argv], { cwd: hostCheckout, env, encoding: "utf8" });
  const ci = await npmRun(["ci", "--include=dev"]);
  if (ci.status !== 0) return { status: "failed", from: before, to: after, line: `failed: npm ci --include=dev exited ${ci.status}` };
  const build = await npmRun(UI_DEPLOY_ARGS);
  if (build.status !== 0) return { status: "failed", from: before, to: after, line: `failed: UI deploy exited ${build.status}` };
  return { status: "deployed", from: before, to: after, line: `deployed ${before.slice(0, SHORT)}..${after.slice(0, SHORT)}` };
}

/** Restarts the bus, UI and runner as one transient unit, so restarting the UI does not stop this command. */
export function restartServices({ run = execRun, stamp = Date.now() } = {}) {
  return run("systemd-run", ["--user", "--collect", `--unit=ai-collab-restart-${stamp}`, "systemctl", "--user", "restart", ...SERVICES], { encoding: "utf8" });
}

/** Starts `ai-collab deploy` detached as its own transient unit and returns once systemd has started it. */
export async function startDeploy({ run = execRun, nodePath = process.execPath, hostCheckout = HOST_CHECKOUT, stamp = Date.now() } = {}) {
  const result = await run("systemd-run", ["--user", "--collect", `--unit=ai-collab-deploy-${stamp}`, nodePath, join(hostCheckout, "scripts/ai-collab.mjs"), "deploy"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`systemd-run failed: ${lastLine(result.stderr) || `exit ${result.status}`}`);
  return result;
}

/** The runner schedule that runs `deploy --if-moved` every 5 minutes. */
export function autoDeployEntry({ nodePath = process.execPath, hostCheckout = HOST_CHECKOUT } = {}) {
  return {
    name: "auto-deploy", everyMs: AUTO_DEPLOY_EVERY_MS, cwd: hostCheckout, timeoutMs: AUTO_DEPLOY_TIMEOUT_MS,
    command: [nodePath, join(hostCheckout, "scripts/ai-collab.mjs"), "deploy", "--if-moved"],
  };
}

const lastDeployPath = (env) => join(stateDir(env), "deploy-last.json");

/** The last deploy result the CLI recorded, or null before any deploy. */
export function readLastDeploy(env = process.env) {
  try {
    return JSON.parse(readFileSync(lastDeployPath(env), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function writeLastDeploy(env, record) {
  mkdirSync(stateDir(env), { recursive: true });
  writeFileSync(lastDeployPath(env), `${JSON.stringify(record)}\n`);
}

/** The UI's adapter: the host's gh and systemd calls. */
export const hostLand = {
  list: () => listOpenPrs(),
  merge: (number, headSha) => mergePr(number, headSha),
  startDeploy: () => startDeploy(),
  lastDeploy: (env) => readLastDeploy(env),
};
