// One builder attempt: the agent in its sandbox, collection, and the limit retry chain.
import * as S from "../sandbox.ts";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stateDir } from "../config.mjs";
import { PROMPT_MAX_CHARS } from "../start.mjs";
import { cursorLimitFile, cursorLimitUntil, detectLimit, fallbackChain, isBlockingLimit, recordCursorLimit } from "../limits.ts";
import { listModels } from "../models.mjs";
import { traceStream } from "../cursor-trace.mjs";
import { OUT, SANDBOX, WORK } from "../sandbox.ts";
import { BUILDER_HARNESSES, DEFAULT_MODEL, BASE_REF, SYNC_TIMEOUT_MS, readState, updateState } from "./state.ts";
import type { BuilderPaths, BuilderState, Env } from "./state.ts";
import { harnessCommand } from "./policy.ts";
import { builderSandboxGone, must, uploadBuilderSandbox, hasInstall, stage } from "./stage.ts";
import type { BuilderContext, BuilderStaged } from "./stage.ts";
import { prepareSettlement } from "./settle.ts";

/** The sandbox notes appended to every builder brief. */
export function briefNotes({ task, branch, workdir }: { task: string; branch: string; workdir: string }) {
  return [
    "",
    "## Builder sandbox",
    `You run inside an OpenShell sandbox. Your worktree is ${workdir} on branch ${branch}; ${BASE_REF} is the base.`,
    "git, node, npm and oncebitten are on PATH. Commit your work on this branch with git; the host copies your commits back after you exit.",
    `\`ai-collab task set|progress\` are recorded and applied on the host when you exit; \`ai-collab task show ${task}\` prints a snapshot. Nothing else of ai-collab works here.`,
    "Use TMPDIR=$(mktemp -d -p /tmp) for the test suite: /dev/shm is not writable here.",
    `Before marking the task done, run \`oncebitten check --base ${BASE_REF}\` and fix what fires.`,
    `Finish with \`ai-collab task set ${task} status=done\`, or status=blocked detail=<reason>.`,
    "",
  ].join("\n");
}

export function cursorLimitPath(model: string, env: Env) {
  return { state: cursorLimitFile(model, env) };
}

export function cursorLimitDetail(harness: string, model: string, env: Env) {
  if (harness !== "cursor") return undefined;
  const until = cursorLimitUntil(model, env);
  if (until > Date.now()) return `Cursor ${model} reached its usage limit. Choose another approved model or retry after ${new Date(until).toISOString()}.`;
}

/** Retry chain after a Codex usage limit: lib/limits.ts's chain, Codex only as another configured model. */
export function fallbackAttempts(env: Env, { model = "", available = [], models = {} }: { model?: string; available?: string[]; models?: Record<string, string[]> } = {}) {
  return fallbackChain({ harness: "codex", model, models: leadWithDefaults(models), available, env }).map(({ harness, model: next }) => ({ harness, model: next }));
}

// A harness's default model leads its listed models, so a retry does not take the catalogue's first entry.
function leadWithDefaults(models: Record<string, string[]>) {
  return Object.fromEntries(Object.entries(models).map(([harness, list]) => {
    const preferred = (DEFAULT_MODEL as Record<string, string>)[harness];
    return [harness, preferred && list.includes(preferred) ? [preferred, ...list.filter((name) => name !== preferred)] : list];
  }));
}

/** The first retry target: defaults.json "limitFallback" ("harness:model"), else Cursor DeepSeek. */
export function limitFallback(env: Env) {
  return fallbackAttempts(env)[0];
}

export async function retryLimitedBuilder(state: BuilderState, paths: BuilderPaths, context: BuilderContext) {
  const { openshell, env, log, signal } = context;
  const sandbox = state.sandbox;
  let { fallback } = readState(paths);
  let resuming = fallback?.phase === "running";
  if (typeof fallback === "string") throw new Error("builder interrupted during fallback; inspect " + sandbox);
  const models = await listModels(stateDir(env), env, { peers: [], run: async () => "" }).catch(() => ({}));
  const available = BUILDER_HARNESSES.filter((harness) => hasInstall(harness, state, env));
  fallback ??= { remaining: fallbackAttempts(env, { model: state.model, available, models }), detail: "Codex reached its usage limit. No fallback model is available." };
  while (fallback.remaining.length) {
    signal?.throwIfAborted();
    const attempt = { ...state, ...fallback.remaining[0] };
    if (!fallback.phase) {
      const limited = cursorLimitDetail(attempt.harness, attempt.model, env);
      if (limited) {
        fallback = { remaining: fallback.remaining.slice(1), detail: `Codex reached its usage limit. ${limited}` };
        continue;
      }
      if (!hasInstall(attempt.harness, state, env)) {
        log(`no ${attempt.harness} install found on the host; trying the next model`);
        fallback = { remaining: fallback.remaining.slice(1), detail: `Codex reached its usage limit. No ${attempt.harness} install was found on the host.` };
        continue;
      }
      fallback = { ...fallback, phase: "staging" };
      updateState(paths, { fallback, phase: "staging", workspaceUploaded: false, collected: false });
    }
    if (fallback.phase === "staging") {
      // Replacement is safe once the previous workspace and calls are on the host.
      const gone = await builderSandboxGone(state, { openshell, env });
      if (!gone.ok) throw new Error("could not replace builder sandbox: " + gone.detail);
      updateState(paths, { sandboxCreated: false });
      log(`Codex usage limit reached; retrying with ${attempt.harness}:${attempt.model}`);
      const staged = await stage(attempt, paths, { env, log, resume: join(paths.back, basename(state.worktree)) });
      await uploadBuilderSandbox(attempt, paths, staged, context);
      if (existsSync(paths.out)) await S.uploadAll({ openshell, env, sandbox, local: paths.out, remote: SANDBOX });
      fallback = { ...fallback, staged, phase: "running" };
      updateState(paths, { fallback, phase: "running", workspaceUploaded: true });
    }
    if (fallback.phase === "running") {
      const agent = resuming ? {
        ...attempt,
        prompt: builderResumePrompt(attempt.prompt ?? readFileSync(paths.brief, "utf8")),
      } : attempt;
      resuming = false;
      const result = await runSandboxAgent(agent, paths, fallback.staged, context);
      fallback = { ...fallback, phase: "collecting", result };
      updateState(paths, { fallback, phase: "collecting", exitCode: result.exitCode });
    }
    if (fallback.phase === "collecting") {
      await collect(attempt, paths, fallback.staged, context);
      fallback = { ...fallback, phase: "collected" };
      updateState(paths, { fallback, phase: "collected" });
    }
    const { exitCode, usageLimit, limitDetail } = fallback.result;
    const limited = limitDetail ?? (usageLimit ? `${attempt.harness} reached its usage limit.` : undefined);
    if (!limited) {
      await prepareSettlement(attempt, paths, exitCode, context);
      return;
    }
    fallback = { remaining: fallback.remaining.slice(1), detail: `Codex reached its usage limit. ${limited}` };
    updateState(paths, { fallback });
  }
  await prepareSettlement(state, paths, readState(paths).exitCode, { env, log, limitDetail: fallback.detail });
}

export async function runSandboxAgent(state: BuilderState, paths: BuilderPaths, staged: BuilderStaged, { openshell, env, log, onChild, signal }: BuilderContext & { onChild?: (child: ChildProcess | null) => void }) {
  signal?.throwIfAborted();
  const original = state.prompt ?? readFileSync(paths.brief, "utf8");
  const brief = staged.builderCode ? original + "\nUse ai-collab-code run_code to batch related sh, read, grep and edit operations. "
    + "Check command exit codes and return only the findings needed for your next decision." : original;
  const launcher = staged.layout.file ? staged.layout.dir + "/" + basename(staged.layout.tree) : undefined;
  const argv = S.execArgv({
    openshell, sandbox: state.sandbox, workdir: staged.workdir, env: staged.execEnv,
    command: harnessCommand({ ...state, brief, workdir: staged.workdir, launcher, builderCode: staged.builderCode } as Parameters<typeof harnessCommand>[0]),
  });
  log("running " + state.harness + " " + state.model + " in sandbox " + state.sandbox);
  const cursor = state.harness === "cursor";
  const codex = state.harness === "codex";
  const stdio: ("ignore" | "pipe" | "inherit")[] = cursor || codex ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"];
  const child = spawn(argv[0], argv.slice(1), { env, stdio });
  onChild?.(child);
  const stop = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", stop, { once: true });
  // A Cursor builder's stream-json passes through to the log and becomes its OTLP trace (model, tokens, tool calls).
  const trace = cursor ? traceStream(child.stdout, { env, out: process.stdout, role: "builder", model: state.model }) : null;
  let errorTail = "";
  let cursorLimit: string | undefined;
  let usageLimit = false;
  if (codex) {
    let outputTail = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      process.stdout.write(chunk);
      outputTail = (outputTail + chunk).slice(-8192);
      // Codex stdout can contain assistant text alongside explicit errors.
      usageLimit ||= outputTail.split(/\r?\n/).some((line) =>
        /^\s*error:/i.test(line) && isBlockingLimit(detectLimit("codex", line)));
    });
  }
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    process.stderr.write(chunk);
    errorTail = (errorTail + chunk).slice(-8192);
    if (cursor) {
      // Cursor reports a limit as an ActionRequiredError line; the shared detector decides which of those lines is one.
      const lines = errorTail.match(/^ActionRequiredError:[^\r\n]*/gim) ?? [];
      cursorLimit = lines.find((line) => isBlockingLimit(detectLimit("cursor", line))) ?? cursorLimit;
    } else {
      // Each line is its own text: a rate line and a reset line from different places are not one limit.
      usageLimit ||= errorTail.split(/\r?\n/).some((line) => isBlockingLimit(detectLimit("codex", line)));
    }
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => {
    signal?.removeEventListener("abort", stop);
    onChild?.(null);
  });
  signal?.throwIfAborted();
  await trace?.finish({ exitStatus: exitCode === 0 ? undefined : "error" });
  if (exitCode !== 0 && cursorLimit) await recordCursorLimit(state.model, cursorLimit, { env });
  return { exitCode, usageLimit: exitCode !== 0 && usageLimit,
    limitDetail: exitCode !== 0 && cursorLimit ? cursorLimitDetail(state.harness, state.model, env) : undefined };
}

export function builderResumePrompt(prompt: string) {
  const instruction = "The runner restarted during this assignment. Inspect the existing workspace and continue the task. Preserve any work already completed.";
  return instruction + "\n\n" + prompt.slice(0, PROMPT_MAX_CHARS - instruction.length - 2);
}

// Copies a credentials file the harness refreshed inside back to the host, unless the host's changed meanwhile; never logs it.
async function keepRefreshedAuth(state: BuilderState, staged: BuilderStaged, { openshell, env, log }: BuilderContext) {
  const { layout } = staged;
  if (!layout.auth || !staged.authHash) return;
  const remote = `${layout.authDir}/${basename(layout.auth)}`;
  const res = await S.runTool(openshell, S.execArgv({ openshell, sandbox: state.sandbox, command: ["cat", remote] }).slice(1), { env });
  if (res.code !== 0 || !res.stdout.trim()) return;
  const inside = createHash("sha256").update(res.stdout).digest("hex");
  if (inside === staged.authHash) return;
  if (S.fileHash(layout.auth) !== staged.authHash) { log(`${state.harness} credentials changed on both sides; kept the host's`); return; }
  const tmp = `${layout.auth}.builder-${process.pid}`;
  writeFileSync(tmp, res.stdout, { mode: 0o600 });
  renameSync(tmp, layout.auth);
  log(`${state.harness} refreshed its credentials in the sandbox; copied them back to the host`);
}

// Downloads the worktree clone and the recorded hook payloads and task calls.
export async function collect(state: BuilderState, paths: BuilderPaths, staged: BuilderStaged, { openshell, env, log }: BuilderContext) {
  log(`collecting workspace from sandbox ${state.sandbox}`);
  await keepRefreshedAuth(state, staged, { openshell, env, log });
  await S.runTool(openshell, S.execArgv({ openshell, sandbox: state.sandbox, command: ["rm", "-f", `${staged.workdir}/node_modules`] }).slice(1), { env });
  await downloadWorktree(state, paths, openshell, env);
  updateState(paths, { collected: true });
  rmSync(paths.out, { recursive: true, force: true });
  const got = await S.runTool(openshell, ["sandbox", "download", state.sandbox, OUT, paths.out], { env, timeoutMs: SYNC_TIMEOUT_MS });
  if (got.code !== 0) log("no recorded task calls or hook payloads");
}

export async function downloadWorktree(state: BuilderState, paths: BuilderPaths, openshell: string, env: Env) {
  const name = basename(state.worktree);
  const incoming = mkdtempSync(join(paths.dir, "download-"));
  try {
    await must(openshell, ["sandbox", "download", state.sandbox, `${WORK}/${name}`, join(incoming, name)], env, "sandbox download");
    if (!existsSync(join(incoming, name, ".git"))) throw new Error("Downloaded workspace is missing its Git repository");
    rmSync(paths.back, { recursive: true, force: true });
    renameSync(incoming, paths.back);
  } finally {
    rmSync(incoming, { recursive: true, force: true });
  }
}

export async function cleanupBuilderSandbox(state: BuilderState, paths: BuilderPaths, { openshell, env, log }: BuilderContext) {
  const final = readState(paths);
  if (final.sandboxCreated && (!final.workspaceUploaded || final.collected)) {
    const gone = await builderSandboxGone(state, { openshell, env });
    log(gone.ok ? `sandbox ${state.sandbox} deleted` : `sandbox delete failed: ${gone.detail}`);
    updateState(paths, { sandboxDeleted: gone.ok, sandboxCreated: !gone.ok });
  }
}
