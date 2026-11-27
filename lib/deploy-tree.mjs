// The deployed tree: one link the systemd units run through, the drop-ins that route them, and the --from source checks.
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { stateDir } from "./config.mjs";
import { runnerRequest, runnerSocket } from "./runner-request.mjs";

export const DROP_IN = "deploy-tree.conf";
export const DBOS_VERSION = /export const DBOS_APP_VERSION = "([^"]+)"/;
export const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Last non-empty line of a stream, for error messages. */
function lastLine(text) {
  return (text || "").trim().split("\n").at(-1) || "";
}

/** Symlink the systemd units run through. */
export function deployLink(env) {
  return join(stateDir(env), "current");
}

/** Current deploy target, or null when the link is absent. */
export function readLink(env) {
  try {
    return readlinkSync(deployLink(env));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/** Atomically point the deploy link at absolute tree. */
export function pointLink(env, tree) {
  mkdirSync(stateDir(env), { recursive: true });
  const link = deployLink(env);
  const tmp = `${link}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(tree, tmp);
  renameSync(tmp, link);
}

/** Cache holding one worktree per deployed branch. */
export function deployCache(env) {
  return join(env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache"), "ai-collab-deploy");
}

/** Directory of user systemd units. */
export function unitsDir(env) {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "systemd", "user");
}

/** Effective [Service] WorkingDirectory and ExecStart across unit and drop-ins. */
function parseService(unitText, dropIns) {
  let workingDirectory = null;
  let execStart = [];
  for (const text of [unitText, ...dropIns]) {
    let section = "";
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith("[")) {
        section = line;
      } else if (section === "[Service]" && line.startsWith("WorkingDirectory=")) {
        workingDirectory = line.slice("WorkingDirectory=".length).trim();
      } else if (section === "[Service]" && line.startsWith("ExecStart=")) {
        const value = line.slice("ExecStart=".length).trim();
        execStart = value === "" ? [] : [...execStart, value];
      }
    }
  }
  return { workingDirectory, execStart };
}

/** Matches the checkout path (absolute or %h form) only at a token boundary. */
function checkoutPattern(hostCheckout, home) {
  const forms = [hostCheckout];
  if (hostCheckout.startsWith(`${home}/`)) forms.push(`%h${hostCheckout.slice(home.length)}`);
  return `(?:${forms.map(escapeRegExp).join("|")})(?=/|\\s|$)`;
}

/** Drop-in text that repoints a unit at the deployed tree. */
export function unitDropIn({ unitText, dropIns, hostCheckout, home, link }) {
  const { execStart } = parseService(unitText, dropIns);
  if (execStart.length !== 1) throw new Error(`unit needs exactly one ExecStart, found ${execStart.length}`);
  const command = execStart[0];
  const pattern = checkoutPattern(hostCheckout, home);
  if (!new RegExp(pattern).test(command)) throw new Error(`ExecStart does not run the host checkout ${hostCheckout}: ${command}`);
  const rewritten = command.replace(new RegExp(pattern, "g"), link);
  return [
    `# Written by \`ai-collab deploy --install-units\`: the service runs the deployed tree through ${link}.`,
    "[Service]",
    `WorkingDirectory=${link}`,
    "ExecStart=",
    `ExecStart=${rewritten}`,
    "",
  ].join("\n");
}

/** Write the deploy drop-in for each service and reload systemd. */
export async function installUnits({ env, hostCheckout, run, services }) {
  const dir = unitsDir(env);
  const link = deployLink(env);
  const home = env.HOME || homedir();
  const written = [];
  for (const service of services) {
    const unitPath = join(dir, `${service}.service`);
    if (!existsSync(unitPath)) throw new Error(`${unitPath} is missing`);
    const unitText = readFileSync(unitPath, "utf8");
    const dropInDir = join(dir, `${service}.service.d`);
    const dropIns = [];
    if (existsSync(dropInDir)) {
      const names = readdirSync(dropInDir).filter((name) => name.endsWith(".conf") && name !== DROP_IN).sort();
      for (const name of names) dropIns.push(readFileSync(join(dropInDir, name), "utf8"));
    }
    const text = unitDropIn({ unitText, dropIns, hostCheckout, home, link });
    mkdirSync(dropInDir, { recursive: true });
    const dropInPath = join(dropInDir, DROP_IN);
    writeFileSync(dropInPath, text);
    written.push(dropInPath);
  }
  if (readLink(env) === null) pointLink(env, hostCheckout);
  const res = await run("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(lastLine(res.stderr) || "systemctl --user daemon-reload failed");
  return written;
}

/** True when every service already has the deploy drop-in. */
export function unitsInstalled(env, services) {
  const dir = unitsDir(env);
  return services.every((service) => existsSync(join(dir, `${service}.service.d`, DROP_IN)));
}

/** DBOS app version declared in the tree, or null. */
export function dbosVersion(tree) {
  const file = join(tree, "lib", "workflows.ts");
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8").match(DBOS_VERSION)?.[1] ?? null;
}

/** Addresses of sessions the runner currently reports as running. */
export async function inFlight(env, { request = runnerRequest } = {}) {
  try {
    const res = await request("GET", "/v1/sessions", undefined, { socket: runnerSocket(env), timeoutMs: 3000 });
    if (res.status !== 200) return [];
    return (res.body?.sessions ?? []).filter((s) => s.status === "running").map((s) => s.session);
  } catch {
    return [];
  }
}

/** Resolve a deploy source (path or branch name) to { kind, tree, ref }. */
export async function resolveSource(from, { run, hostCheckout, env, cwd }) {
  if (from.startsWith("/") || from.startsWith("./") || from.startsWith("../")) {
    const tree = realpathSync(resolve(cwd, from));
    const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd: tree, encoding: "utf8" });
    if (top.status !== 0 || top.stdout.trim() !== tree) throw new Error(`${tree} is not a git checkout`);
    const pkgPath = join(tree, "package.json");
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      throw new Error(`${pkgPath} is missing or unreadable`);
    }
    if (pkg.name !== "ai-collab") throw new Error(`${tree} is not an ai-collab checkout`);
    const head = await run("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd: tree, encoding: "utf8" });
    if (head.status === 0 && head.stdout.trim()) return { kind: "path", tree, ref: head.stdout.trim() };
    const sha = await run("git", ["rev-parse", "HEAD"], { cwd: tree, encoding: "utf8" });
    if (sha.status !== 0) throw new Error(`${tree} has no HEAD commit`);
    return { kind: "path", tree, ref: `detached ${sha.stdout.trim().slice(0, 12)}` };
  }
  if (from === "main") throw new Error("refusing branch main: use --main");
  if (!BRANCH_NAME.test(from)) throw new Error(`${from} is not a valid branch name`);
  const valid = await run("git", ["check-ref-format", "--branch", from], { cwd: hostCheckout, encoding: "utf8" });
  if (valid.status !== 0) throw new Error(`${from} is not a valid branch name`);
  const cache = deployCache(env);
  const tree = join(cache, from);
  if (tree !== cache && !tree.startsWith(cache + sep)) throw new Error(`${from} escapes the deploy cache`);
  return { kind: "branch", tree, ref: from };
}

/** Run git in cwd; throw with the last stderr line on failure. */
async function gitOrThrow(run, cwd, args) {
  const res = await run("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(lastLine(res.stderr) || `git ${args[0]} failed`);
  return res.stdout.trim();
}

/** Materialize branch as a detached tree; returns the commit sha. */
export async function checkoutBranch({ run, hostCheckout, tree, branch }) {
  const local = await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], { cwd: hostCheckout, encoding: "utf8" });
  let sha = local.stdout.trim();
  if (local.status !== 0 || !sha) {
    const fetched = await run("git", ["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: hostCheckout, encoding: "utf8" });
    if (fetched.status !== 0) throw new Error(lastLine(fetched.stderr) || `git fetch ${branch} failed`);
    sha = await gitOrThrow(run, hostCheckout, ["rev-parse", `refs/remotes/origin/${branch}^{commit}`]);
  }
  if (!sha) throw new Error(`${branch} does not resolve to a commit`);
  if (!existsSync(tree)) {
    mkdirSync(dirname(tree), { recursive: true });
    await gitOrThrow(run, hostCheckout, ["worktree", "add", "--detach", tree, sha]);
  } else {
    await gitOrThrow(run, tree, ["checkout", "--detach", "--quiet", sha]);
  }
  return sha;
}

/** True when the tree has uncommitted tracked changes. */
export async function dirty(run, tree) {
  return (await gitOrThrow(run, tree, ["status", "--porcelain", "--untracked-files=no"])).length > 0;
}
