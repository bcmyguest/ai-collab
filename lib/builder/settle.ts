// Settlement: commit, fast-forward the host branch, oncebitten check, and the task verdict.
import * as S from "../sandbox.ts";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { clipProgress, openTasks, reviewPacket, STATUSES } from "../tasks.ts";
import { cleanBuilders } from "../builder-clean.ts";
import { loadConfig } from "../config.ts";
import { task } from "../task-cli.ts";
import { WORK } from "../sandbox.ts";
import { BUILDER_HARNESSES, BASE_REF, GIT_TIMEOUT_MS, readState, updateState, oneLine } from "./state.ts";
import type { BuilderPaths, BuilderState, Env } from "./state.ts";
import { git, findOncebitten } from "./stage.ts";

/** Whether a recorded call may be replayed on the host: only `task set` and `task progress`. */
export function replayable(argv: string[]) {
  return argv[0] === "task" && (argv[1] === "set" || argv[1] === "progress") && argv.length >= 4;
}

/** Splits a recorded shim call (NUL-terminated arguments) into argv. */
export function parseRecordedCall(text: string) {
  const parts = String(text).split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

// Save the verified verdict before publishing it.
const HARNESS_NAMES = { cursor: "Cursor", codex: "Codex", claude: "Claude", opencode: "OpenCode" } as const;

export async function prepareSettlement(state: BuilderState, paths: BuilderPaths, exitCode: number | null, { env, log, limitDetail }: { env: Env; log: (text: string) => void; limitDetail?: string }) {
  const back = join(paths.back, basename(state.worktree));
  const hostGit = (cwd: string, args: string[]) => git(cwd, args, env);
  const harnessName = HARNESS_NAMES[state.harness as keyof typeof HARNESS_NAMES];
  const trailer = `Assisted-by: ${harnessName}:${state.model}`;
  if (await S.commitUncommitted({ git: hostGit, repo: back, message: `chore(builder): uncommitted work from ${state.id}`, trailer })) log("committed the agent's uncommitted changes on the host");
  const commits = await S.commitsAhead({ git: hostGit, repo: back, base: state.base });
  let landed = false;
  let commit: string | undefined;
  let landError = "";
  if (commits > 0) {
    try {
      commit = (await git(back, ["rev-parse", "HEAD"], env)).trim();
      await git(state.worktree, ["fetch", "--quiet", back, "HEAD"], env);
      await git(state.worktree, ["merge", "--quiet", "--ff-only", "FETCH_HEAD"], env);
      landed = true;
      log(`${commits} commit(s) on ${state.branch}`);
    } catch (error) {
      landError = `could not fast-forward ${state.branch}; the work is kept in ${back}: ${oneLine((error as Error).message)}`;
      log(landError);
    }
  }
  // Report sinks do not all offer idempotency keys. An interrupted replay requires operator review.
  if (readState(paths).replayingReports) throw new Error("builder interrupted while replaying reports; inspect " + paths.out);
  updateState(paths, { replayingReports: true });
  const captured = await replayCaptures(state, paths, env, log);
  const check = landed ? await oncebittenCheck(state, env) : { code: 0, text: "" };
  const requested = await replayCalls(state, paths, env, log);
  let status = "blocked";
  let detail = limitDetail;
  if (landError) detail = landError;
  else if (check.code !== 0) {
    const reason = check.code === 1 ? "fired" : "could not run";
    detail = "oncebitten check --base " + BASE_REF + " " + reason + ": " + (check.text || "exit " + check.code);
    log(detail);
  } else if (requested !== "blocked") {
    if (exitCode === 0 && landed) status = "review";
    else detail ??= `builder ${state.unit} exited ${exitCode} with ${commits} commit(s) and ${requested ? "requested " + requested : "set no status"}`;
  }
  // A finished build waits for the operator's verdict, so the packet rides with the settlement the runner saved above.
  const review = status === "review" ? reviewPacket({
    submission: randomUUID(), commit, base: state.base, branch: state.branch,
    criteria: reviewCriteria(state, paths, env), check, numstat: await reviewNumstat(back, state.base, env),
  }) : undefined;
  const outcome = `builder ${state.unit}: exit ${exitCode}, ${commits} commit(s) on ${state.branch}, ${captured} oncebitten capture(s)`;
  const progress = limitDetail ? `${limitDetail} ${outcome}` : outcome;
  updateState(paths, { settlement: { commits, landed, status, detail, captured, oncebitten: landed ? check.code : null, checkText: check.text, progress, ...(review ? { review } : {}), at: Date.now() } });
  log(`settled as ${status} (agent exit ${exitCode}, requested ${requested || "no status"}, oncebitten ${landed ? "exit " + check.code : "skipped"})`);
}

// The criteria a reviewer judges the build against: the task's own detail, else the brief's opening paragraph.
function reviewCriteria(state: BuilderState, paths: BuilderPaths, env: Env) {
  let detail = "";
  try { detail = openTasks(state.project, env).get(state.task).detail || ""; } catch { /* store unreadable; fall back to the brief */ }
  if (detail.trim()) return detail;
  try {
    const brief = readFileSync(paths.brief, "utf8").split("\n## Builder sandbox\n")[0].trim();
    return brief.split(/\n{2,}/)[0] || brief;
  } catch { return ""; }
}

// Per-file line counts for the packet; a missing range is not worth failing the settlement over.
async function reviewNumstat(back: string, base: string, env: Env) {
  try { return await git(back, ["diff", "--numstat", `${base}..HEAD`], env); } catch { return ""; }
}

export async function publishSettlement(state: BuilderState, paths: BuilderPaths, env: Env) {
  const { at, progress, detail, ...result } = readState(paths).settlement;
  const tasks = openTasks(state.project, env);
  const entry = { by: state.unit, text: clipProgress(progress || detail).text };
  // The progress entry and verdict are written together. On retry the entry proves publication.
  if (!tasks.get(state.task).progress.some((p: { at?: number; by?: string; text?: string }) => p.at === at && p.by === entry.by && p.text === entry.text)) {
    // A runner killed while holding this lock can leave it behind until the stale-lock timeout.
    await tasks.update(state.task, { status: result.status, ...(result.review ? { review: result.review } : {}), ...(detail !== undefined ? { detail } : {}), progress: entry }, at, { waitMs: 45_000 });
  }
  if (result.landed) rmSync(paths.back, { recursive: true, force: true });
  rmSync(paths.stage, { recursive: true, force: true });
  updateState(paths, { phase: result.error ? "failed" : "finished", ended: Date.now(), ...result });
  await cleanBuilders(env);
}

// Feeds every saved hook payload to the host's `oncebitten capture`, with sandbox paths mapped to the host worktree.
async function replayCaptures(state: BuilderState, paths: BuilderPaths, env: Env, log: (text: string) => void) {
  const dir = join(paths.out, "oncebitten");
  if (!existsSync(dir)) return 0;
  const bin = env.AI_COLLAB_ONCEBITTEN_BIN || findOncebitten(env);
  if (!bin) { log("oncebitten is not installed on the host; captures dropped"); return 0; }
  const workdir = `${WORK}/${basename(state.worktree)}`;
  let count = 0;
  for (const file of readdirSync(dir).sort()) {
    const host = file.replace(/\.json$/, "").split("-").slice(2).join("-") || state.harness;
    const payload = readFileSync(join(dir, file), "utf8").split(workdir).join(state.worktree);
    if (!payload.trim()) continue;
    const res = await S.runTool(bin, ["capture", "--host", BUILDER_HARNESSES.includes(host) ? host : state.harness], { env, cwd: state.worktree, stdin: payload });
    if (res.code === 0) count += 1;
  }
  return count;
}

// Own-task status assignments are requests. Replay other fields and progress as usual.
async function replayCalls(state: BuilderState, paths: BuilderPaths, env: Env, log: (text: string) => void) {
  const dir = join(paths.out, "ai-collab");
  let requested = "";
  if (!existsSync(dir)) return requested;
  for (const file of readdirSync(dir).sort()) {
    const argv = parseRecordedCall(readFileSync(join(dir, file), "utf8"));
    if (!replayable(argv)) { log(`skipped recorded call: ${argv.slice(0, 2).join(" ")}`); continue; }
    let status;
    if (argv[1] === "set" && argv[2] === state.task) {
      const fields = argv.slice(3);
      status = fields.findLast(a => a.startsWith("status="))?.slice(7);
      if (status !== undefined && !STATUSES.includes(status)) {
        log(`skipped recorded call with invalid status: ${status}`);
        continue;
      }
      argv.splice(3, fields.length, ...fields.filter(a => !a.startsWith("status=")));
    }
    try {
      if (argv.length > 3) await taskCli(argv, env);
      if (status) requested = status;
    } catch (error) {
      log(`recorded call failed: ${(error as Error).message}`);
    }
  }
  return requested;
}

async function oncebittenCheck(state: BuilderState, env: Env) {
  const bin = env.AI_COLLAB_ONCEBITTEN_BIN || findOncebitten(env);
  if (!bin) {
    const lock = join(state.worktree, ".oncebitten", "rules.lock");
    const local = join(dirname(lock), "rules.local");
    const configured = (existsSync(local) && readdirSync(local).length > 0) || (existsSync(lock) && !/^source\s*=\s*\[\s*\]$/.test(readFileSync(lock, "utf8").trim()));
    return configured ? { code: 2, text: "oncebitten is not installed" } : { code: 0, text: "" };
  }
  const res = await S.runTool(bin, ["check", "--base", state.base], { env, cwd: state.worktree, timeoutMs: GIT_TIMEOUT_MS });
  return { code: res.code, text: oneLine(`${res.stdout} ${res.stderr}`).slice(0, 300) };
}

// Runs `ai-collab task ...` in-process; throws with its stderr on a non-zero exit.
async function taskCli(argv: string[], env: Env) {
  let errText = "";
  const sink = { write: () => true };
  const code = await task(argv.slice(1), { env, cfg: loadConfig(env), out: sink, err: { write: (s: string) => { errText += s; return true; } } });
  if (code !== 0) throw new Error(oneLine(errText) || `ai-collab ${argv.join(" ")} exited ${code}`);
}
