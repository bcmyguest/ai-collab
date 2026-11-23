import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";

const HOST_CHECKOUT = "/home/b/ai-collab";
const USAGE = `Usage: ai-collab merge start <builder/branch>

Runs on the PM host using ${HOST_CHECKOUT}. Tests the merged commit in a separate
worktree with isolated HOME, CODEX_HOME and TMPDIR before pushing to origin/main.
Builder worktrees (~875 tests) do not qualify for the host gate (~1215 tests).`;

export function merge(args, {
  env, out, err, run = spawnSync, hostCheckout = HOST_CHECKOUT, tempRoot = "/dev/shm",
}) {
  if (args.length === 0 || args[0] === "help" || args.includes("--help")) {
    out.write(`${USAGE}\n`);
    return 0;
  }
  const [action, branch] = args;
  if (action !== "start" || args.length !== 2 || !/^builder\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch)) {
    err.write(`${USAGE}\n`);
    return 1;
  }

  function command(file, argv, { cwd = hostCheckout, commandEnv = env, capture = false } = {}) {
    const result = run(file, argv, {
      cwd, env: commandEnv, encoding: "utf8",
      stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const details = result.stdout?.trim();
      throw new Error(`${file} ${argv.join(" ")} failed (${result.signal ?? result.status})` +
        (details ? `\n${details}` : ""));
    }
    return result.stdout?.trim();
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
    if (git("rev-parse", "--show-toplevel") !== hostCheckout ||
        git("symbolic-ref", "--short", "HEAD") !== "main") {
      throw new Error(`expected the host main checkout at ${hostCheckout}`);
    }
    git("check-ref-format", `refs/heads/${branch}`);
    const builder = git("rev-parse", "--verify", `refs/heads/${branch}^{commit}`);
    git("fetch", "origin", "+refs/heads/main:refs/remotes/origin/main");
    const base = git("rev-parse", "--verify", "refs/remotes/origin/main^{commit}");
    worktree = mkdtempSync(join(dirname(hostCheckout), "ai-collab-wt-merge-"));
    const mergeBranch = `merge/${basename(worktree).slice("ai-collab-wt-merge-".length)}`;
    git("worktree", "add", "-b", mergeBranch, worktree, base);
    out.write(`Merge worktree: ${worktree} (${mergeBranch})\n`);
    git("-C", worktree, "merge", "--no-edit", builder);
    const merged = git("-C", worktree, "rev-parse", "HEAD");

    scratch = mkdtempSync(join(tempRoot, "ai-collab-merge-"));
    const home = mkdtempSync(join(scratch, "home-"));
    const commandEnv = {
      ...gitEnv,
      PATH: [dirname(process.execPath), env.PATH].filter(Boolean).join(delimiter),
      HOME: home,
      CODEX_HOME: join(home, ".codex"),
      TMPDIR: mkdtempSync(join(scratch, "tmp-")),
    };
    command("npm", ["ci"], { cwd: worktree, commandEnv });
    command("npm", ["test"], { cwd: worktree, commandEnv });
    if (git("-C", worktree, "rev-parse", "HEAD") !== merged ||
        git("-C", worktree, "status", "--porcelain", "--untracked-files=no")) {
      throw new Error("tests changed the merge commit or tracked files");
    }
    // A normal push rejects an intervening, divergent update to main.
    git("-C", worktree, "push", "origin", `${merged}:refs/heads/main`);
    out.write(`Pushed ${merged} to origin/main. Next, on the host:\n` +
      `  cd ${hostCheckout}\n` +
      "  git pull --ff-only\n" +
      "  npm ci && npm run build && systemctl --user restart ai-collab-ui\n" +
      "  node tools/smoke-ui.mjs\n");
    return 0;
  } catch (error) {
    err.write(`ai-collab: merge: ${error.message}\n`);
    if (worktree) err.write(`Inspect the merge worktree at ${worktree}.\n`);
    return 1;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
