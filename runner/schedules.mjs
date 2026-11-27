// Scheduled commands: schedules.json entries become durable scheduled workflows that run one command per tick.
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir, listProjects, stateDir } from "../lib/config.mjs";
import { MISSION_FILE, withMission } from "../lib/mission.ts";
import { refreshPmWorkspace } from "../lib/pm-workspace.mjs";
import { withReview } from "../lib/pm-review.ts";
import { isProjectPaused, PROJECT_PAUSED } from "../lib/project-pause.ts";
import { harnessOfCommand, projectOfFolder, sessionOfCommand } from "../lib/schedule-session.mjs";
import { childEnv } from "../lib/start.mjs";
import { SYSTEM_PROMPT_ENV } from "../lib/machine-prompt.mjs";
import { ROLE_ENV } from "../lib/cursor-trace.ts";
import { scopeLaunch } from "../lib/sessions/scope.ts";
import { agentHarness, hostAgentRefusal } from "../lib/agent-guard.mjs";

export const DEFAULT_TIMEOUT_SEC = 900;
export const TAIL_CHARS = 2000;
export const KILL_GRACE_MS = 5000;
export const TICK_STEP = "command";
const MAX_EVERY_MINUTES = 525_600;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEYS = ["name", "everyMinutes", "cwd", "command", "timeoutSec", "wakeOnTasks", "sandbox", "workspace"];
// Runs a "sandbox": true entry's agent command inside a fresh OpenShell sandbox (runner/sandbox-run.mjs).
export const SANDBOX_RUN = fileURLToPath(new URL("./sandbox-run.mjs", import.meta.url));
// Host settings for the sandbox helper, which builds its own environment for the harness.
const SANDBOX_RUN_KEYS = [
  "AI_COLLAB_OPENSHELL_BIN", "AI_COLLAB_STATE_DIR",
  "AI_COLLAB_CURSOR_TREE", "AI_COLLAB_CODEX_TREE", "AI_COLLAB_CLAUDE_BIN", "AI_COLLAB_OPENCODE_BIN",
  "AI_COLLAB_BUILDER_NODE", "AI_COLLAB_BUILDER_NODE_MODULES", "AI_COLLAB_BUILDER_GIT",
  "AI_COLLAB_BUILDER_GIT_CORE", "AI_COLLAB_BUILDER_ONCEBITTEN",
];

/** The schedules file: AI_COLLAB_SCHEDULES, else <config dir>/schedules.json. */
export const schedulesPath = (env = process.env) => env.AI_COLLAB_SCHEDULES || join(configDir(env), "schedules.json");

function invalid(index, message) {
  throw new Error(`schedules.json entry ${index}: ${message}`);
}

// Checks one entry and returns it with everyMs and timeoutMs; throws on the first problem.
function checkEntry(entry, index) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid(index, "not an object");
  if (entry.cron !== undefined) invalid(index, "cron schedules are not supported; use everyMinutes");
  const unknown = Object.keys(entry).filter((key) => !KEYS.includes(key));
  if (unknown.length) invalid(index, `unknown key ${unknown.join(", ")}`);
  if (typeof entry.name !== "string" || !NAME.test(entry.name)) invalid(index, "name must be 1-40 lowercase letters, digits or dashes");
  if (!Number.isSafeInteger(entry.everyMinutes) || entry.everyMinutes < 1 || entry.everyMinutes > MAX_EVERY_MINUTES) {
    invalid(index, `everyMinutes must be an integer from 1 to ${MAX_EVERY_MINUTES}`);
  }
  if (typeof entry.cwd !== "string" || !isAbsolute(entry.cwd)) invalid(index, "cwd must be an absolute path");
  if (!statSync(entry.cwd, { throwIfNoEntry: false })?.isDirectory()) invalid(index, `cwd ${entry.cwd} is not a directory`);
  if (!Array.isArray(entry.command) || !entry.command.length || !entry.command.every((arg) => typeof arg === "string") || !entry.command[0]) {
    invalid(index, "command must be a non-empty array of strings");
  }
  const timeoutSec = entry.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  if (!Number.isSafeInteger(timeoutSec) || timeoutSec < 1) invalid(index, "timeoutSec must be a positive integer");
  if (timeoutSec >= entry.everyMinutes * 60) invalid(index, "timeoutSec must be shorter than everyMinutes");
  // wakeOnTasks names a project whose finished tasks start this schedule early.
  if (entry.wakeOnTasks !== undefined && (typeof entry.wakeOnTasks !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(entry.wakeOnTasks))) invalid(index, "wakeOnTasks must be a project name");
  if (entry.sandbox !== undefined && typeof entry.sandbox !== "boolean") invalid(index, "sandbox must be true or false");
  if (entry.sandbox && !agentHarness(entry.command)) invalid(index, "sandbox: true needs a command that runs claude, codex, cursor-agent or opencode");
  // The directory need not exist yet: a pm tick clones it. cwd stays the registered project.
  if (entry.workspace !== undefined && (typeof entry.workspace !== "string" || !isAbsolute(entry.workspace))) invalid(index, "workspace must be an absolute path");
  return { name: entry.name, everyMs: entry.everyMinutes * 60_000, cwd: entry.cwd, command: entry.command, timeoutMs: timeoutSec * 1000, ...(entry.wakeOnTasks ? { wakeOnTasks: entry.wakeOnTasks } : {}), ...(entry.sandbox ? { sandbox: true } : {}), ...(entry.workspace ? { workspace: entry.workspace } : {}) };
}

/**
 * Reads the schedules file. Returns {entries, errors}: each invalid entry is left out and reported, so one typo
 * does not stop the others. A missing file is no schedules.
 */
export function loadSchedules(env = process.env) {
  const file = schedulesPath(env);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { entries: [], errors: [] };
    return { entries: [], errors: [`${file}: ${error.message}`] };
  }
  let list;
  try {
    list = JSON.parse(text);
  } catch (error) {
    return { entries: [], errors: [`${file} is not valid JSON: ${error.message}`] };
  }
  if (!Array.isArray(list)) return { entries: [], errors: [`${file} must hold a JSON array of schedules`] };
  const entries = [];
  const errors = [];
  const names = new Set();
  list.forEach((raw, index) => {
    try {
      const entry = checkEntry(raw, index);
      if (names.has(entry.name)) invalid(index, `name ${entry.name} appears twice`);
      names.add(entry.name);
      entries.push(entry);
    } catch (error) {
      errors.push(error.message);
    }
  });
  return { entries, errors };
}

/**
 * Runs argv in its own process group (no shell, stdin closed). A timeout or abort sends SIGTERM to the group, then
 * SIGKILL after graceMs. Resolves {ok, exitCode, signal, timedOut, durationMs, tail}; rejects when signal aborts.
 * With `scope`, the command runs in its own transient systemd scope, so a runner restart does not kill an agent it
 * started; the scope execs the command, so the process group and the timeout handling are the same either way.
 */
export function runCommand(command, { cwd, env = process.env, timeoutMs, signal, graceMs = KILL_GRACE_MS, scope = null }) {
  const [given, ...givenArgs] = command;
  // A scope outlives this process, so the timeout is also handed to systemd: it cuts the command if the caller dies.
  const launch = scope ? scopeLaunch(command, { ...scope, kind: "schedule", runtimeMaxSec: timeoutMs === undefined ? 0 : timeoutMs / 1000 }) : null;
  const [file, runArgs] = launch ? [launch.file, launch.args] : [given, givenArgs];
  const started = Date.now();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const child = spawn(file, runArgs, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true });
    let tail = "";
    let timedOut = false;
    let aborted = false;
    let exit = null;
    let spawnError = null;
    let deadline;
    let escalate;
    let giveUp;
    let closeFallback;
    let settled = false;

    const keep = (chunk) => { tail = (tail + chunk).slice(-TAIL_CHARS); };
    const killGroup = (sig) => {
      const { pid } = child;
      if (pid === undefined) return;
      try { process.kill(-pid, sig); } catch { /* the group is already gone */ }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      // A process left running may still hold the pipes: drain them without keeping its output.
      for (const stream of [child.stdout, child.stderr]) { stream.removeListener("data", keep); stream.resume(); stream.unref?.(); }
      for (const timer of [deadline, escalate, giveUp, closeFallback]) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (aborted) return reject(signal.reason);
      const durationMs = Date.now() - started;
      if (spawnError) return resolve({ ok: false, exitCode: null, signal: null, timedOut: false, durationMs, tail: spawnError.message.slice(-TAIL_CHARS) });
      resolve({ ok: !timedOut && exit?.code === 0, exitCode: exit?.code ?? null, signal: exit?.signal ?? null, timedOut, durationMs, tail });
    };
    const terminate = () => {
      if (escalate) return;
      killGroup("SIGTERM");
      escalate = setTimeout(() => {
        killGroup("SIGKILL");
        giveUp = setTimeout(finish, graceMs); // a process that survives SIGKILL is not waited for
      }, graceMs);
    };
    const onAbort = () => { aborted = true; terminate(); };

    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (error) => { spawnError = error; finish(); });
    child.on("exit", (code, sig) => {
      exit = { code, signal: sig };
      // Background work the command started (an agent it handed off to) outlives a clean exit; only a timeout or abort kills the group.
      closeFallback = setTimeout(finish, graceMs); // stdio can outlive the exit
    });
    child.on("close", (code, sig) => {
      exit ??= { code, signal: sig };
      finish();
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    deadline = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
  });
}

/** The argv a sandboxed entry's tick runs: the sandbox runner, then the agent command after "--". */
export function sandboxRunCommand(entry, command, project = "") {
  return [process.execPath, SANDBOX_RUN, "--name", entry.name, "--cwd", entry.cwd, ...(project ? ["--project", project] : []), "--", ...command];
}

/** The workflow body for one entry: one checkpointed command step, not re-run after a cut. */
export function tickFn(entry, { env = process.env, log = () => {}, graceMs, projects, refresh = refreshPmWorkspace } = {}) {
  return async (scheduledTime, actualTime, wf) => {
    // The mission file is read here, every tick, so a PM edit reaches the next tick without touching schedules.json.
    // cwd stays the registered project. A pm workspace is a separate clone: the command and the mission come from it.
    const project = projectOfFolder(entry.cwd, projects ?? listProjects(env));
    let runCwd = entry.cwd;
    let missionFile = "";
    if (entry.name === "pm" && entry.workspace) {
      refresh(entry.workspace, { source: entry.cwd, log, env });
      runCwd = entry.workspace;
      missionFile = join(entry.workspace, MISSION_FILE);
    }
    // The review comes last, after the mission, so it is the closing instruction of every run; a project with no
    // mission file still gets it, and the review says to write the file first.
    const command = [...withMission(entry.command, { project, env, log, ...(missionFile ? { file: missionFile } : {}) })];
    if (entry.name === "pm" && project && harnessOfCommand(command)) {
      command[command.length - 1] += [
        "",
        "Review project outcomes with ai-collab task outcomes.",
        'For a requested outcome, run ai-collab task propose-outcome <outcome-id> "<task title>" ["<task title>" ...] with one to three tasks. Wait for operator approval before working on them.',
        'When every linked task is done, run the acceptance check and record evidence with ai-collab task report-outcome <outcome-id> pass|fail "<evidence>". Leave closure to the operator.',
      ].join("\n");
    }
    const reviewedCommand = withReview(command, { project });
    // The command runs in its own scope, so a runner restart does not kill an agent a tick started; it also outlives
    // the tick's own timeout only if the scope cannot be made, where the group kill still applies.
    const result = await wf.step(TICK_STEP, () => {
      if (project && harnessOfCommand(entry.command) && !sessionOfCommand(entry.command) && isProjectPaused({ project, stateDir: stateDir(env) })) {
        return { ok: false, exitCode: null, signal: null, timedOut: false, durationMs: 0, tail: PROJECT_PAUSED };
      }
      const refusal = hostAgentRefusal(reviewedCommand, { sandboxed: Boolean(entry.sandbox), env });
      if (refusal) return { ok: false, exitCode: null, signal: null, timedOut: false, durationMs: 0, tail: refusal };
      const run = entry.sandbox ? sandboxRunCommand({ ...entry, cwd: runCwd }, reviewedCommand, project) : reviewedCommand;
      const pass = entry.sandbox ? Object.fromEntries(SANDBOX_RUN_KEYS.filter((key) => env[key]).map((key) => [key, env[key]])) : {};
      return runCommand(run, { cwd: runCwd, env: { ...childEnv(env), ...pass, [SYSTEM_PROMPT_ENV]: "1", [ROLE_ENV]: `schedule:${entry.name}` }, timeoutMs: entry.timeoutMs, signal: wf.signal, graceMs, scope: { env, label: entry.name, description: `AI Collab schedule ${entry.name}` } });
    }, {
      onCut: () => ({ ok: false, exitCode: null, signal: null, timedOut: false, durationMs: 0, tail: "", cut: "runner restarted during the run; not re-run" }),
    });
    const how = result.timedOut ? " (timed out)" : result.signal ? ` (${result.signal})` : "";
    log(`${entry.name}: ${result.ok ? "ok" : "failed"}${how} in ${result.durationMs} ms`);
    return { ...result, scheduledTime: scheduledTime.toISOString(), actualTime: actualTime.toISOString() };
  };
}

/** Registers each entry with the durable log as a scheduled workflow; returns the names. */
export function registerSchedules(durable, entries, { env = process.env, log = () => {}, projects } = {}) {
  for (const entry of entries) {
    durable.scheduled(entry.name, { everyMs: entry.everyMs, firstStep: TICK_STEP }, tickFn(entry, { env, log, projects }));
  }
  return entries.map((entry) => entry.name);
}
