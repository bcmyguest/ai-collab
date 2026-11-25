// Unit launch and the durable supervisor that runs a builder inside a systemd unit.
import * as S from "../sandbox.ts";
import { isProjectPaused, PROJECT_PAUSED } from "../project-pause.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { autoDefaults } from "../config.mjs";
import { projectRoot, PROMPT_MAX_CHARS, modelShape } from "../start.mjs";
import { runnerRequest, runnerSocket } from "../runner-request.mjs";
import { RUN_ID } from "../pattern-runs.mjs";
import { openTasks } from "../tasks.mjs";
import { BUILDER_DIR_CAP, builderLiveRefusal, cleanBuilders } from "../builder-clean.mjs";
import { WORK } from "../sandbox.ts";
import { CLI_SCRIPT, BUILDER_HARNESSES, DEFAULT_MODEL, ID_RE, BASE_REF, BUILDER_START_TIMEOUT_MS, GIT_TIMEOUT_MS, FINAL_PHASES, LIVE_STATES, builderPaths, builderId, readState, writeState, updateState, oneLine } from "./state.mjs";
import { git, createSandbox, upload, stage } from "./stage.mjs";
import { briefNotes, cursorLimitDetail, retryLimitedBuilder, runSandboxAgent, collect, cleanupBuilderSandbox } from "./run.mjs";
import { prepareSettlement, publishSettlement } from "./settle.mjs";

export async function startBuilder(flags, { env, cfg, readBrief }) {
  const order = autoDefaults(env)?.builderOrder;
  const preferred = Array.isArray(order) ? order.find((name) => BUILDER_HARNESSES.includes(name)) : undefined;
  const harness = flags.harness ?? preferred ?? "codex";
  if (!BUILDER_HARNESSES.includes(harness)) throw new Error("Unknown builder harness");
  if (flags.run !== undefined && !RUN_ID.test(flags.run)) throw new Error("invalid run id");
  if (!cfg.project) throw new Error("AI_COLLAB_PROJECT is not set and no project matches this folder");
  if (isProjectPaused(cfg)) throw new Error(PROJECT_PAUSED);
  const task = openTasks(cfg.project, env).list().find((t) => t.id === flags.task);
  if (!task) throw new Error(`no task ${flags.task} in project ${cfg.project}`);
  const id = builderId(flags.task);
  if (!ID_RE.test(id)) throw new Error(`task id ${flags.task} gives no usable builder id`);
  const paths = builderPaths(id, env);
  const brief = (readBrief ? readBrief() : flags.brief).trim();
  if (!brief) throw new Error("Builder brief is empty");
  const branch = flags.branch || `builder/${id}`;
  const model = flags.model || DEFAULT_MODEL[harness];
  const limited = cursorLimitDetail(harness, model, env);
  if (limited) throw new Error(limited);
  const workdir = `${WORK}/${basename(paths.worktree)}`;
  const prompt = `${brief}\n${briefNotes({ task: task.id, branch, workdir })}`;
  if (!readBrief) {
    if (!modelShape(harness, model)) throw new Error("Invalid builder model");
    if (brief.startsWith("-") || brief.includes("\0")) throw new Error("Start the builder brief with a heading or sentence and omit NUL characters");
    if (harness === "codex" && prompt.trim().length > PROMPT_MAX_CHARS) {
      throw new Error(`Builder brief and sandbox notes must fit within ${PROMPT_MAX_CHARS} characters`);
    }
  }
  if (existsSync(paths.worktree)) throw new Error(`worktree ${paths.worktree} already exists`);
  if (LIVE_STATES.includes(await unitState(paths.unit, env))) throw new Error(`unit ${paths.unit} is already running`);
  const crowded = builderLiveRefusal(env);
  if (crowded) throw new Error(crowded);
  const capped = await S.sandboxCapRefusal({ openshell: env.AI_COLLAB_OPENSHELL_BIN || "openshell", env, name: paths.sandbox, project: cfg.project });
  if (capped) throw new Error(capped);
  // One free slot: this start adds a directory, and the count must still end at the cap.
  await cleanBuilders(env, { cap: BUILDER_DIR_CAP - 1 });
  const root = projectRoot(cfg.project, env);
  await git(root, ["worktree", "add", "--quiet", paths.worktree, "-b", branch, BASE_REF], env);
  const nodeModules = join(root, "node_modules");
  if (existsSync(nodeModules)) symlinkSync(nodeModules, join(paths.worktree, "node_modules"));
  const base = (await git(root, ["rev-parse", BASE_REF], env)).trim();
  rmSync(paths.dir, { recursive: true, force: true });
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.brief, prompt);
  return launchBuilder(paths, {
    ...(flags.run ? { run: flags.run } : {}), id, task: task.id, project: cfg.project, harness, model, branch, base, root,
    worktree: paths.worktree, unit: paths.unit, sandbox: paths.sandbox,
  }, { env });
}

export async function launchBuilder(paths, state, { env }) {
  const socket = runnerSocket(env);
  const owned = state.harness === "codex" && await runnerRequest("GET", "/v1/health", undefined, { socket, timeoutMs: 1000 }).then(() => true, (error) => {
    if (["ENOENT", "ECONNREFUSED"].includes(error.code)) return false;
    throw error;
  });
  writeState(paths, { ...state, owned, phase: "starting", started: Date.now(), attempt: randomUUID() });
  try {
    return await dispatchBuilder(paths, state, { env, owned, socket });
  } catch (error) {
    if (readState(paths).phase === "starting" && (!owned || (error.status && error.status !== 504))) {
      updateState(paths, { phase: "failed", ended: Date.now(), error: error.message });
    }
    throw error;
  }
}

async function dispatchBuilder(paths, state, { env, owned, socket }) {
  const { id, task, project, model, branch, run } = state;
  if (owned) {
    const { status, body } = await runnerRequest("POST", "/v1/sessions", {
      project, harness: "codex", place: "openshell", model, taskId: task,
      builder: id, prompt: state.prompt ?? readFileSync(paths.brief, "utf8"),
    }, { socket, timeoutMs: BUILDER_START_TIMEOUT_MS + 10_000 });
    if (status !== 201) throw Object.assign(new Error(body?.error || "runner start returned HTTP " + status), { status });
    return { session: body.session, task, sandbox: paths.sandbox, worktree: paths.worktree, branch };
  }
  const started = await S.runTool(env.AI_COLLAB_SYSTEMD_RUN_BIN || "systemd-run", unitArgv(paths, project, task, env), { env, timeoutMs: GIT_TIMEOUT_MS });
  if (started.code !== 0) {
    updateState(paths, { phase: "failed", error: `systemd-run: ${(started.stderr || "").trim()}` });
    throw new Error(`systemd-run failed: ${(started.stderr || "").trim() || `exit ${started.code}`}`);
  }
  return { unit: paths.unit, task, sandbox: paths.sandbox, worktree: paths.worktree, branch };
}

// systemd-run argv: a transient user unit, so a UI or runner restart cannot kill the builder.
function unitArgv(paths, project, taskId, env) {
  const pass = Object.entries(env).filter(([k]) => k === "PATH" || k === "HOME" || k === "CARGO_HOME" || k.startsWith("AI_COLLAB_") || k.startsWith("XDG_") || k === "CODEX_HOME");
  const setenv = [...pass.filter(([k]) => k !== "AI_COLLAB_PROJECT" && k !== "AI_COLLAB_BUILDER_TASK"), ["AI_COLLAB_PROJECT", project], ["AI_COLLAB_BUILDER_TASK", taskId]].map(([k, v]) => `--setenv=${k}=${v}`);
  return [
    "--user", "--collect", "--quiet", "--property=TimeoutStopSec=40min", "--property=KillMode=mixed", "--property=Restart=on-abnormal", `--unit=${paths.unit}`, `--working-directory=${paths.worktree}`,
    `--description=ai-collab builder ${basename(paths.dir)} (sandboxed)`, ...setenv,
    process.execPath, CLI_SCRIPT, "builder", "run", basename(paths.dir),
  ];
}

// The supervisor inside the unit: sandbox, run, copy back, commit, task status, cleanup.
export async function runBuilder(id, { env, out, err }) {
  const paths = builderPaths(id, env);
  const state = readState(paths);
  if (state.owned) throw new Error("This builder is managed by the runner");
  const log = (line) => out.write(`builder ${id}: ${line}\n`);
  const openshell = env.AI_COLLAB_OPENSHELL_BIN || "openshell";
  let child = null;
  let stopping = false;
  const onTerm = () => {
    stopping = true;
    child?.kill("SIGTERM");
  };
  const { openDurable } = await import("../durable.mjs");
  const { acquireLock } = await import("../../runner/lock.mjs");
  const release = acquireLock(join(paths.dir, "workflow.lock"));
  let durable;
  process.once("SIGTERM", onTerm);
  try {
    const journal = state.attempt ? "workflow-" + state.attempt + ".db" : "workflow.db";
    durable = openDurable(join(paths.dir, journal));
    durable.register("builder", async (wf) => {
      const context = { openshell, env, log, onChild: (process) => { child = process; } };
      let exitCode = null;
      try {
        const current = readState(paths);
        if (!current.settlement && !FINAL_PHASES.includes(current.phase)) {
          updateState(paths, { pid: process.pid });
          const staged = await wf.step("stage", () => {
            updateState(paths, { phase: "staging" });
            return stage(state, paths, context);
          });
          await wf.step("sandbox.create", async () => {
            await createSandbox({ openshell, env, name: state.sandbox, policy: paths.policy, labels: S.sandboxLabels({ project: state.project, kind: "builder", owner: state.id }) });
            updateState(paths, { phase: "uploading", sandboxCreated: true });
          }, { onCut: () => {
            if (!readState(paths).sandboxCreated) throw new Error("builder interrupted during sandbox creation; inspect " + state.sandbox);
          } });
          const authHash = await wf.step("sandbox.upload", async () => {
            await upload(state, paths, staged, context);
            updateState(paths, { workspaceUploaded: true });
            return staged.authHash;
          });
          staged.authHash = authHash;
          await wf.step("builder.ready", async () => {
            if (stopping) return;
            const tasks = openTasks(state.project, env);
            if (state.prompt || state.run || tasks.get(state.task).status !== "building") {
              await tasks.update(state.task, { status: "building", ...(state.prompt ? { owner: undefined } : {}), ...(state.run ? { run: state.run } : {}) });
            }
            if (!stopping) updateState(paths, { phase: "running" });
          });
          const attempt = await wf.step("agent.run", async () => {
            if (stopping) return { exitCode: 143 };
            const result = await runSandboxAgent(state, paths, staged, context);
            return stopping ? { exitCode: 143 } : result;
          }, {
            onCut: () => ({ exitCode: 143 }),
          });
          exitCode = attempt.exitCode;
          await wf.step("sandbox.collect", async () => {
            updateState(paths, { phase: "collecting", exitCode });
            await collect(state, paths, staged, context);
          });
          await wf.step("prepare settlement", async () => {
            if (attempt.usageLimit && exitCode !== 143) await retryLimitedBuilder(state, paths, context);
            else await prepareSettlement(state, paths, exitCode, { ...context, limitDetail: attempt.limitDetail });
          });
        }
      } catch (error) {
        err.write("builder " + id + ": " + error.message + "\n");
        const detail = "builder " + state.unit + " failed: " + oneLine(error.message);
        if (!readState(paths).settlement) {
          updateState(paths, { exitCode, settlement: { status: "blocked", detail, at: Date.now(), error: error.message } });
        }
      }
      // The persisted verdict makes publication repeatable even after the staging files are removed.
      try {
        const final = readState(paths);
        if (final.settlement && !FINAL_PHASES.includes(final.phase)) {
          await publishSettlement(state, paths, env);
        }
      } finally {
        await cleanupBuilderSandbox(state, paths, context);
      }
      return Number(Boolean(readState(paths).settlement?.error));
    });
    if (!durable.status(id)) return await durable.startWorkflow("builder", id, {});
    durable.recover();
    const result = await durable.result(id);
    const status = durable.status(id);
    if (status.status === "ERROR") throw new Error(status.error);
    return result;
  } finally {
    process.removeListener("SIGTERM", onTerm);
    try { await durable?.close(); } finally { release(); }
  }
}

// Stops a builder this command started (it has a state file), then deletes its sandbox.
export async function stopBuilder(id, { env, out, err }) {
  const paths = builderPaths(builderId(id), env);
  let state;
  try { state = readState(paths); } catch { err.write(`ai-collab: builder stop: no builder ${id} started by ai-collab builder start\n`); return 1; }
  if (state.owned) {
    if (!state.address) throw new Error("builder session has not been claimed");
    const route = state.address.replace("#", "/");
    const { status, body } = await runnerRequest("DELETE", "/v1/sessions/" + route, undefined, { socket: runnerSocket(env) });
    if (status !== 200) throw new Error(body?.error || "runner stop returned HTTP " + status);
    out.write([state.address, body.status].join("\t") + "\n");
    return 0;
  }
  const stopped = await S.runTool(env.AI_COLLAB_SYSTEMCTL_BIN || "systemctl", ["--user", "stop", state.unit], { env, timeoutMs: 41 * 60_000 });
  const current = readState(paths);
  if (stopped.code === 0) {
    if (current.started === state.started && !FINAL_PHASES.includes(current.phase)) {
      updateState(paths, { phase: "stopped", ended: Date.now() });
    }
    await cleanBuilders(env);
    const sandbox = current.sandboxDeleted ? "sandbox deleted" : current.sandboxCreated ? "sandbox retained" : "no sandbox";
    out.write([state.unit, "stopped", sandbox].join("\t") + "\n");
  } else {
    out.write([state.unit, "stop failed: " + (stopped.stderr || "").trim()].join("\t") + "\n");
  }
  return stopped.code === 0 ? 0 : 1;
}

export async function unitState(unit, env) {
  const res = await S.runTool(env.AI_COLLAB_SYSTEMCTL_BIN || "systemctl", ["--user", "show", "-p", "ActiveState", "--value", unit], { env });
  return res.code === 0 ? res.stdout.trim() || "unknown" : "unknown";
}
