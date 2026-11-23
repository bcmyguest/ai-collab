import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { COMMIT_ID } from "./build-review.mjs";
import { findExecutable } from "./start.mjs";

export const HOST_CHECKOUT = "/home/b/ai-collab";

const BRANCH = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;
const USAGE = `Usage: ai-collab merge start [--expect-tip <commit>] <branch>...

Runs on the PM host using ${HOST_CHECKOUT}. Fetches origin, merges each local
branch onto origin/main in a fresh worktree, runs the gate there with isolated
HOME, CODEX_HOME and TMPDIR, pushes on green, checks origin with ls-remote,
then pulls the host checkout with --ff-only. Prints one result line:
  merge: merged <sha> (<branches>); host pulled | host pull skipped: <reason>
  merge: refused: <reason>
Builder worktrees (~875 tests) do not qualify for the host gate (~1215 tests).`;

class Refused extends Error {}

export function merge(args, {
  env, out, err, run = spawnSync, hostCheckout = HOST_CHECKOUT, tempRoot = "/dev/shm",
}) {
  if (args.length === 0 || args[0] === "help" || args.includes("--help")) {
    out.write(`${USAGE}\n`);
    return 0;
  }
  const [action, ...branches] = args;
  const expected = branches[0] === "--expect-tip" ? branches.splice(0, 2)[1] ?? "" : undefined;
  if (action !== "start" || branches.length === 0 ||
      (expected !== undefined && (!COMMIT_ID.test(expected) || branches.length !== 1)) ||
      branches.some((branch) => !BRANCH.test(branch) || branch === "main")) {
    err.write(`${USAGE}\n`);
    return 1;
  }

  function command(file, argv, { cwd = hostCheckout, commandEnv = env, capture = false, check = true } = {}) {
    const result = run(file, argv, {
      cwd, env: commandEnv, encoding: "utf8",
      stdio: ["ignore", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
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
  try {
    // Repository selectors inherited from a Git hook must not redirect these commands.
    const gitEnv = { ...env };
    for (const key of command("git", ["rev-parse", "--local-env-vars"], { capture: true }).split("\n")) {
      delete gitEnv[key];
    }
    const git = (...argv) => command("git", argv, { commandEnv: gitEnv, capture: true });
    const tryGit = (...argv) => command("git", argv, { commandEnv: gitEnv, capture: true, check: false });
    if (git("rev-parse", "--show-toplevel") !== hostCheckout ||
        git("symbolic-ref", "--short", "HEAD") !== "main") {
      throw new Error(`expected the host main checkout at ${hostCheckout}`);
    }
    const commits = branches.map((branch) => {
      git("check-ref-format", `refs/heads/${branch}`);
      return git("rev-parse", "--verify", `refs/heads/${branch}^{commit}`);
    });
    if (expected !== undefined && commits[0] !== expected) {
      throw new Refused("the build branch moved past the submitted commit");
    }
    git("fetch", "origin", "+refs/heads/main:refs/remotes/origin/main");
    const base = git("rev-parse", "--verify", "refs/remotes/origin/main^{commit}");
    worktree = mkdtempSync(join(dirname(hostCheckout), "ai-collab-wt-merge-"));
    const mergeBranch = `merge/${basename(worktree).slice("ai-collab-wt-merge-".length)}`;
    git("worktree", "add", "-b", mergeBranch, worktree, base);
    out.write(`Merge worktree: ${worktree} (${mergeBranch})\n`);
    branches.forEach((branch, index) => {
      if (tryGit("-C", worktree, "merge", "--no-edit", commits[index]).status !== 0) {
        tryGit("-C", worktree, "merge", "--abort");
        throw new Refused(`${branch} does not merge cleanly onto origin/main; nothing pushed`);
      }
    });
    const merged = git("-C", worktree, "rev-parse", "HEAD");

    scratch = mkdtempSync(join(tempRoot, "ai-collab-merge-"));
    const home = mkdtempSync(join(scratch, "home-"));
    const node = realpathSync(process.execPath);
    const nodeBin = dirname(node);
    const commandEnv = {
      ...gitEnv,
      PATH: [nodeBin, env.PATH].filter(Boolean).join(delimiter),
      HOME: home,
      CODEX_HOME: join(home, ".codex"),
      TMPDIR: mkdtempSync(join(scratch, "tmp-")),
    };
    // Use the running Node installation's npm even if PATH has no npm launcher.
    const npmCli = join(nodeBin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
    const [npm, ...npmArgs] = existsSync(npmCli) ? [node, npmCli] : [findExecutable("npm", commandEnv.PATH)];
    if (!npm) throw new Error(`npm was not found for Node at ${node}`);
    for (const step of ["ci", "test"]) {
      const result = command(npm, [...npmArgs, step], { cwd: worktree, commandEnv, check: false });
      if (result.status !== 0) throw new Refused(`npm ${step} failed (${result.signal ?? result.status}); nothing pushed`);
    }
    if (git("-C", worktree, "rev-parse", "HEAD") !== merged ||
        git("-C", worktree, "status", "--porcelain", "--untracked-files=no")) {
      throw new Refused("tests changed the merge commit or tracked files; nothing pushed");
    }
    // A normal push rejects an intervening, divergent update to main.
    git("-C", worktree, "push", "origin", `${merged}:refs/heads/main`);
    const remote = git("-C", worktree, "ls-remote", "origin", "refs/heads/main").split(/\s/)[0];
    if (remote !== merged) throw new Refused(`origin main is ${remote || "missing"}, not the pushed ${merged}`);

    // Never force: a pull that local edits or a diverged main would block is reported instead.
    const pull = tryGit("pull", "--ff-only");
    const host = pull.status === 0 ? "host pulled"
      : `host pull skipped: ${(pull.stderr || pull.stdout || `exit ${pull.status}`).trim().split("\n").pop()}`;
    tryGit("worktree", "remove", "--force", worktree);
    tryGit("branch", "-D", mergeBranch);
    worktree = undefined;
    out.write("Next, on the host: npm ci && npm run build && systemctl --user restart ai-collab-ui" +
      " && node tools/smoke-ui.mjs\n");
    out.write(`merge: merged ${merged} (${branches.join(" ")}); ${host}\n`);
    return 0;
  } catch (error) {
    if (worktree) err.write(`Inspect the merge worktree at ${worktree}.\n`);
    if (!(error instanceof Refused)) err.write(`ai-collab: merge: ${error.message}\n`);
    out.write(`merge: refused: ${error.message.split("\n")[0]}\n`);
    return 1;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
