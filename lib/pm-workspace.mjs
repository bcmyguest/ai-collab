/**
 * The PM workspace is a separate clone of the schedule cwd's origin, not a linked
 * worktree of the host checkout. A tick refreshes it before the command runs.
 * Creating the directory clones origin and checks out main. An existing clone is
 * never reset: a clean one is fast-forwarded, a dirty one is left as it is.
 * The source repo is only read for its origin URL.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function gitEnv(base = process.env) {
  const env = { ...base, GIT_TERMINAL_PROMPT: "0" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  return env;
}

function git(run, args, env) {
  let result;
  try {
    result = run("git", args, { encoding: "utf8", env });
  } catch (error) {
    return { status: 1, stdout: "", stderr: error.message };
  }
  if (!result || result.error) {
    return { status: result?.status ?? 1, stdout: result?.stdout || "", stderr: result?.error?.message || result?.stderr || "git failed" };
  }
  return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function lastLine(result) {
  return (result.stderr || result.stdout || `exit ${result.status}`).trim().split("\n").pop();
}

/**
 * Refresh `dir` from the origin of `source`. Returns {ok, dirty?, cloned?, detail}.
 * Logs the reason when the clone is missing, dirty, or cannot fast-forward.
 * `run` is spawnSync-shaped so tests can watch the argv.
 */
export function refreshPmWorkspace(dir, { source, run = spawnSync, log = () => {}, env = process.env } = {}) {
  if (!dir || !source) {
    const detail = "pm workspace: no directory; left it";
    log(detail);
    return { ok: false, detail };
  }
  const childEnv = gitEnv(env);
  if (!existsSync(dir)) {
    const url = git(run, ["-C", source, "remote", "get-url", "origin"], childEnv);
    if (url.status !== 0 || !url.stdout.trim()) {
      const detail = `pm workspace ${dir} is missing and ${source} has no origin URL; left it`;
      log(detail);
      return { ok: false, detail };
    }
    const cloned = git(run, ["clone", "--branch", "main", url.stdout.trim(), dir], childEnv);
    if (cloned.status !== 0) {
      const detail = `pm workspace clone failed: ${lastLine(cloned)}`;
      log(detail);
      return { ok: false, detail };
    }
    const detail = `pm workspace ${dir} cloned from origin`;
    log(detail);
    return { ok: true, cloned: true, detail };
  }
  const status = git(run, ["-C", dir, "status", "--porcelain"], childEnv);
  if (status.status !== 0) {
    const detail = `pm workspace ${dir} is not a git clone; left it`;
    log(detail);
    return { ok: false, detail };
  }
  if (status.stdout.trim()) {
    const detail = `pm workspace ${dir} is dirty; left it`;
    log(detail);
    return { ok: true, dirty: true, detail };
  }
  const fetched = git(run, ["-C", dir, "fetch", "origin"], childEnv);
  if (fetched.status !== 0) {
    const detail = `pm workspace fetch failed: ${lastLine(fetched)}`;
    log(detail);
    return { ok: false, detail };
  }
  const pulled = git(run, ["-C", dir, "pull", "--ff-only"], childEnv);
  if (pulled.status !== 0) {
    const detail = `pm workspace pull skipped: ${lastLine(pulled)}`;
    log(detail);
    return { ok: false, detail };
  }
  const detail = `pm workspace ${dir} pulled`;
  log(detail);
  return { ok: true, detail };
}
