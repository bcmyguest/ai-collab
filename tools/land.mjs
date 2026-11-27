// Repo-only dev tool (npm run land): rebase one branch onto origin/main in a cached worktree, gate it there, push main, deploy the host.
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { BRANCH, HOST_CHECKOUT, mergeNode, npmCommand } from "../lib/land.mjs";

const USAGE = `Usage: npm run land -- <branch>

Lands one local branch onto main from the host checkout at ${HOST_CHECKOUT}.
Fetches origin, rebases the branch onto origin/main in a throwaway worktree
under ~/.cache/ai-collab-land, runs the gate there (npm ci, typecheck, lint,
test) with isolated HOME, CODEX_HOME and TMPDIR, pushes the rebased commit to
main with a plain push, verifies origin with ls-remote, then deploys the host
checkout with "ai-collab deploy". Prints one result line:
  land: landed <sha> (<branch>) on main
  land: refused: <reason>
A gate failure keeps the scratch dir and names its gate log.`;
const GATE_STEPS = [["ci"], ["run", "typecheck"], ["run", "lint"], ["test"]];

class Refused extends Error {}

export function landBranch(args, {
  env, out, err, run = spawnSync, hostCheckout = HOST_CHECKOUT,
  cacheRoot = join(env.HOME, ".cache", "ai-collab-land"),
  platform = process.platform, nodePath = process.execPath, npm,
}) {
  if (args.length === 0 || args[0] === "help" || args.includes("--help")) {
    out.write(`${USAGE}\n`);
    return 0;
  }
  if (platform !== "linux") {
    err.write("land: refused: Linux only\n");
    return 1;
  }
  if (env.AI_COLLAB_SESSION) {
    err.write("land: refused: run npm run land from your own terminal, not inside an agent session\n");
    return 1;
  }
  const [branch] = args;
  if (args.length !== 1 || !BRANCH.test(branch) || branch === "main") {
    err.write(`${USAGE}\n`);
    return 1;
  }

  function command(file, argv, { cwd = hostCheckout, commandEnv = env, capture = false, check = true, log } = {}) {
    const output = log ?? (capture ? "pipe" : "inherit");
    const result = run(file, argv, {
      cwd, env: commandEnv, encoding: "utf8",
      stdio: ["ignore", output, output],
    });
    if (result.error) throw result.error;
    if (check && result.status !== 0) {
      const details = [result.stdout, result.stderr].map((text) => text?.trim()).filter(Boolean).join("\n");
      throw new Error(`${file} ${argv.join(" ")} failed (${result.signal ?? result.status})` +
        (details ? `\n${details}` : ""));
    }
    return check ? result.stdout?.trim() : result;
  }

  let worktree;
  let scratch;
  let gateLog;
  try {
    // Repository selectors inherited from a Git hook must not redirect these commands.
    const gitEnv = { ...env };
    for (const key of command("git", ["rev-parse", "--local-env-vars"], { capture: true }).split("\n")) {
      delete gitEnv[key];
    }
    const git = (...argv) => command("git", argv, { commandEnv: gitEnv, capture: true });
    const tryGit = (...argv) => command("git", argv, { commandEnv: gitEnv, capture: true, check: false });
    if (git("rev-parse", "--show-toplevel") !== hostCheckout || git("symbolic-ref", "--short", "HEAD") !== "main") {
      throw new Refused(`expected the host main checkout at ${hostCheckout}`);
    }
    const commit = git("rev-parse", "--verify", `refs/heads/${branch}^{commit}`);
    git("fetch", "origin", "+refs/heads/main:refs/remotes/origin/main");
    const base = git("rev-parse", "refs/remotes/origin/main^{commit}");
    mkdirSync(cacheRoot, { recursive: true });
    worktree = mkdtempSync(join(cacheRoot, "wt-"));
    git("worktree", "add", "--detach", worktree, commit);
    if (tryGit("-C", worktree, "rebase", base).status !== 0) {
      tryGit("-C", worktree, "rebase", "--abort");
      throw new Refused(`${branch} does not rebase cleanly onto origin/main; nothing pushed`);
    }
    const rebased = git("-C", worktree, "rev-parse", "HEAD");

    scratch = mkdtempSync(join(cacheRoot, "gate-"));
    const home = mkdtempSync(join(scratch, "home-"));
    const node = npm ? nodePath : mergeNode(nodePath, hostCheckout, gitEnv);
    const commandEnv = {
      PATH: [dirname(node), env.PATH].filter(Boolean).join(delimiter),
      HOME: home,
      CODEX_HOME: join(home, ".codex"),
      TMPDIR: mkdtempSync(join(scratch, "tmp-")),
    };
    const [npmFile, ...npmArgs] = npm ?? npmCommand(node, commandEnv.PATH);
    gateLog = join(scratch, "gate.log");
    const log = openSync(gateLog, "wx", 0o600);
    try {
      for (const step of GATE_STEPS) {
        writeSync(log, `\n$ npm ${step.join(" ")}\n`);
        const result = command(npmFile, [...npmArgs, ...step], { cwd: worktree, commandEnv, check: false, log });
        if (result.status !== 0) {
          throw new Refused(`npm ${step.join(" ")} failed (${result.signal ?? result.status}); nothing pushed`);
        }
      }
    } finally {
      closeSync(log);
    }
    rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
    gateLog = undefined;

    if (git("-C", worktree, "rev-parse", "HEAD") !== rebased ||
        git("-C", worktree, "status", "--porcelain", "--untracked-files=no")) {
      throw new Refused("the gate changed the rebased commit or tracked files; nothing pushed");
    }
    // A normal push rejects an intervening, divergent update to main.
    git("-C", worktree, "push", "origin", `${rebased}:refs/heads/main`);
    const remote = git("-C", worktree, "ls-remote", "origin", "refs/heads/main").split(/\s/)[0];
    if (remote !== rebased) throw new Refused(`origin main is ${remote || "missing"}, not the pushed ${rebased}`);
    tryGit("worktree", "remove", "--force", worktree);
    worktree = undefined;

    out.write(`land: landed ${rebased} (${branch}) on main\n`);
    const deploy = run(nodePath, [join(hostCheckout, "scripts/ai-collab.mjs"), "deploy"], {
      cwd: hostCheckout, env: gitEnv, stdio: "inherit",
    });
    if ((deploy.status ?? 1) !== 0) {
      err.write(`land: deploy failed (${deploy.signal ?? deploy.status})\n`);
      return 1;
    }
    return 0;
  } catch (error) {
    if (worktree) err.write(`Inspect the land worktree at ${worktree}.\n`);
    if (!(error instanceof Refused)) err.write(`land: ${error.message}\n`);
    const logDetail = gateLog ? `; gate log: ${gateLog}` : "";
    out.write(`land: refused: ${error.message.split("\n")[0]}${logDetail}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = landBranch(process.argv.slice(2), { env: process.env, out: process.stdout, err: process.stderr });
}
