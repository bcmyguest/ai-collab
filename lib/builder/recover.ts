// Recovery after a restart, the task handoff, and the runner-owned builder hooks.
import * as S from "../sandbox.ts";
import { isProjectPaused, PROJECT_PAUSED } from "../project-pause.ts";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stateDir } from "../config.ts";
import { PROMPT_MAX_CHARS } from "../sessions/launch.ts";
import { withLock } from "../state.ts";
import { openTasks } from "../tasks.ts";
import { BUILDER_HARNESSES, DEFAULT_MODEL, ID_RE, BUILDER_START_TIMEOUT_MS, SYNC_TIMEOUT_MS, FINAL_PHASES, LIVE_STATES, builderPaths, builderId, readState, updateState, builderExited, oneLine } from "./state.ts";
import type { BuilderState, Env } from "./state.ts";
import { builderSandboxGone, uploadBuilderSandbox, upload, stage } from "./stage.ts";
import type { BuilderStaged } from "./stage.ts";
import { cursorLimitDetail, retryLimitedBuilder, collect, downloadWorktree, cleanupBuilderSandbox } from "./run.ts";
import { prepareSettlement, publishSettlement } from "./settle.ts";
import { launchBuilder, unitState } from "./supervisor.ts";

/** The stopped builder snapshot used by the task handoff. A task done or waiting for review is not handed off again. */
export function stoppedBuilder(project: string, task: { id: string; status: string }, env: Env) {
  const id = builderId(task.id);
  if (!ID_RE.test(id) || task.status === "done" || task.status === "review") return null;
  const paths = builderPaths(id, env);
  let state: BuilderState;
  try { state = readState(paths); } catch { return null; }
  if (state.project !== project || state.task !== task.id || !FINAL_PHASES.includes(state.phase)
      || state.sandboxCreated || state.sandboxDeleted === false || !existsSync(join(state.worktree, ".git"))) return null;
  if (state.phase !== "finished" || state.commits > 0 && !state.landed) {
    if (existsSync(join(paths.back, basename(state.worktree)))) return null;
  }
  return state;
}

export function builderAssignment(project: string, task: { id: string; status: string; owner?: string }, sessions: { taskId?: string; status?: string }[], env: Env) {
  // A build waiting for review, and a finished one, have nothing to recover.
  if (task.status === "done" || task.status === "review") return null;
  const paths = builderPaths(builderId(task.id), env);
  if (!existsSync(paths.state)) return null;
  let state: BuilderState;
  try { state = readState(paths); } catch { return null; }
  if (state.project !== project || state.task !== task.id) return null;
  if (!builderExited(state)) {
    return !state.owned && task.status === "building" && state.workspaceUploaded && !task.owner ? { builderUnit: state.unit } : null;
  }
  if (sessions.some(session => session.taskId === task.id && session.status !== "ended")) return null;
  if (task.owner && task.owner !== state.address && task.owner !== state.previousOwner) return null;
  const backup = join(paths.back, basename(state.worktree));
  return { recovery: {
    harness: state.harness, choices: BUILDER_HARNESSES.filter(harness => harness !== state.harness),
    worktree: state.worktree, branch: state.branch, commits: state.commits ?? 0,
    sandboxWorkspace: Boolean(state.sandboxCreated && state.workspaceUploaded && !state.collected),
    ...(existsSync(join(backup, ".git")) ? { backup } : {}),
  } };
}

export async function recoverBuilder(project: string, id: string, harness: string | undefined, sessions: () => { taskId?: string; status?: string }[], env: Env) {
  if (isProjectPaused({ project, stateDir: stateDir(env) })) throw new Error(PROJECT_PAUSED);
  const paths = builderPaths(builderId(id), env);
  const result = await withLock(join(paths.dir, "recovery"), async () => {
    const task = openTasks(project, env).get(id);
    const recovery = builderAssignment(project, task, sessions(), env)?.recovery;
    if (!recovery) throw new Error("This task has no recoverable builder");
    const state = readState(paths);
    const nextHarness = harness ?? state.harness;
    if (!BUILDER_HARNESSES.includes(nextHarness)) throw new Error("Unknown builder harness");
    const model = nextHarness === state.harness ? state.model : (DEFAULT_MODEL as Record<string, string>)[nextHarness];
    const limited = cursorLimitDetail(nextHarness, model, env);
    if (limited) throw new Error(limited);
    if (!state.owned && LIVE_STATES.includes(await unitState(state.unit, env))) throw new Error("The previous builder is still stopping");
    if (!existsSync(state.worktree)) throw new Error("The builder worktree is missing");
    const openshell = env.AI_COLLAB_OPENSHELL_BIN || "openshell";
    if (state.sandboxCreated) {
      if (recovery.sandboxWorkspace) await downloadWorktree(state, paths, openshell, env);
      const gone = await builderSandboxGone(state, { openshell, env });
      if (!gone.ok) throw new Error("Could not clear the previous sandbox: " + gone.detail);
      updateState(paths, { sandboxCreated: false });
    }
    const brief = readFileSync(paths.brief, "utf8");
    const last = task.progress.at(-1);
    const context = ["Recover the unfinished assignment. Review the existing changes before continuing.",
      last && "Last task update: " + last.text].filter(Boolean).join("\n\n").slice(0, 1000);
    const prompt = brief.slice(0, PROMPT_MAX_CHARS - context.length - 2) + "\n\n" + context;
    const { id: builder, branch, base, root, worktree, unit, sandbox, run } = state;
    await launchBuilder(paths, {
      id: builder, task: id, project, branch, base, root, worktree, unit, sandbox, run, prompt,
      harness: nextHarness, model,
      previousOwner: task.owner, commits: recovery.commits,
      ...(existsSync(join(paths.back, basename(worktree), ".git")) ? { resume: join(paths.back, basename(worktree)) } : {}),
    }, { env });
  }, { staleMs: 2 * SYNC_TIMEOUT_MS + BUILDER_START_TIMEOUT_MS + 60_000 });
  if (!result.locked) throw new Error("Builder recovery is already in progress");
}

// Runner-owned builders reuse the standalone staging and landing paths.
export function ownedBuilder(project: string, id: string, env: Env) {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error("Invalid builder id");
  const state = readState(builderPaths(id, env));
  if (!state.owned || state.id !== id || state.harness !== "codex" || state.project !== project) throw new Error("Unknown owned builder");
  return state;
}

export function markOwnedBuilderFailed(project: string, id: string, address: string, error: unknown, env: Env) {
  const paths = builderPaths(id, env);
  if (!existsSync(paths.state)) return;
  const current = ownedBuilder(project, id, env);
  if (current.address !== address || FINAL_PHASES.includes(current.phase)) return;
  updateState(paths, { phase: "failed", ended: Date.now(), error });
}

export async function stageOwnedBuilder(state: BuilderState, env: Env, log: (line: string) => void) {
  const paths = builderPaths(state.id, env);
  const openshell = env.AI_COLLAB_OPENSHELL_BIN || "openshell";
  const current = readState(paths);
  updateState(paths, { phase: "staging" });
  const staged = await stage(state, paths, { env, log });
  const context = { openshell, env, log };
  // Only a sandbox recorded as ours can be reused after a partial upload.
  if (!current.sandboxCreated) await uploadBuilderSandbox(state, paths, staged, context);
  else if (!current.workspaceUploaded) await upload(state, paths, staged, context);
  updateState(paths, { workspaceUploaded: true });
  return {
    workdir: staged.workdir,
    layout: { auth: "" },
    argv: S.execArgv({
      openshell, sandbox: state.sandbox, workdir: staged.workdir,
      env: { ...staged.execEnv, AI_COLLAB_OWNED: "codex" },
      command: [`${staged.layout.dir}/${basename(staged.layout.tree)}${staged.layout.launcher}`, "app-server", "-c", "thread_unload_delay_secs=0"],
    }),
  };
}

export async function claimOwnedBuilder(state: BuilderState, address: string, env: Env) {
  // A task already attached to a run retains that association.
  await openTasks(state.project, env).update(state.task, { owner: address, status: "building", ...(state.run ? { run: state.run } : {}) });
  updateState(builderPaths(state.id, env), { phase: "running", address });
}

export async function finishOwnedBuilder(state: BuilderState, staged: BuilderStaged | null, exitCode: number, env: Env, log: (line: string) => void, failure?: string | null, usageLimit = false, signal?: AbortSignal) {
  const paths = builderPaths(state.id, env);
  const openshell = env.AI_COLLAB_OPENSHELL_BIN || "openshell";
  const taskEnv = { ...env, AI_COLLAB_PROJECT: state.project };
  const current = readState(paths);
  if (!FINAL_PHASES.includes(current.phase)) {
    if (!current.settlement) {
      try {
        if (failure) throw new Error(failure);
        signal?.throwIfAborted();
        if (!current.fallback && current.phase !== "collected") {
          await collect(state, paths, staged as BuilderStaged, { openshell, env, log });
          updateState(paths, { phase: "collected", exitCode });
        }
        if (usageLimit || current.fallback) await retryLimitedBuilder(state, paths, { openshell, env: taskEnv, log, signal });
        else await prepareSettlement(state, paths, current.phase === "collected" ? current.exitCode : exitCode, { env: taskEnv, log });
      } catch (error) {
        signal?.throwIfAborted();
        const detail = "builder " + state.id + " failed: " + oneLine((error as Error).message);
        updateState(paths, { settlement: { status: "blocked", detail, at: Date.now(), error: (error as Error).message } });
      }
    }
    await publishSettlement(state, paths, taskEnv);
  }
  await cleanupBuilderSandbox(state, paths, { openshell, env, log });
}
