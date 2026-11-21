// Scheduled commands: schedules.json entries become durable scheduled workflows that run one command per tick.
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { configDir } from "../lib/config.mjs";
import { childEnv } from "../lib/start.mjs";

export const DEFAULT_TIMEOUT_SEC = 900;
export const TAIL_CHARS = 2000;
export const KILL_GRACE_MS = 5000;
export const TICK_STEP = "command";
const MAX_EVERY_MINUTES = 525_600;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEYS = ["name", "everyMinutes", "cwd", "command", "timeoutSec"];

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
  return { name: entry.name, everyMs: entry.everyMinutes * 60_000, cwd: entry.cwd, command: entry.command, timeoutMs: timeoutSec * 1000 };
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
 */
export function runCommand(command, { cwd, env = process.env, timeoutMs, signal, graceMs = KILL_GRACE_MS }) {
  const [file, ...args] = command;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true });
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
      try { process.kill(-child.pid, sig); } catch { /* the group is already gone */ }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
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
      if (!escalate) killGroup("SIGKILL"); // members the command left behind
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

/** The workflow body for one entry: one checkpointed command step, not re-run after a cut. */
export function tickFn(entry, { env = process.env, log = () => {}, graceMs } = {}) {
  return async (scheduledTime, actualTime, wf) => {
    const result = await wf.step(TICK_STEP, () => runCommand(entry.command, { cwd: entry.cwd, env: childEnv(env), timeoutMs: entry.timeoutMs, signal: wf.signal, graceMs }), {
      onCut: () => ({ ok: false, exitCode: null, signal: null, timedOut: false, durationMs: 0, tail: "", cut: "runner restarted during the run; not re-run" }),
    });
    const how = result.timedOut ? " (timed out)" : result.signal ? ` (${result.signal})` : "";
    log(`${entry.name}: ${result.ok ? "ok" : "failed"}${how} in ${result.durationMs} ms`);
    return { ...result, scheduledTime: scheduledTime.toISOString(), actualTime: actualTime.toISOString() };
  };
}

/** Registers each entry with the durable log as a scheduled workflow; returns the names. */
export function registerSchedules(durable, entries, { env = process.env, log = () => {} } = {}) {
  for (const entry of entries) {
    durable.scheduled(entry.name, { everyMs: entry.everyMs, firstStep: TICK_STEP }, tickFn(entry, { env, log }));
  }
  return entries.map((entry) => entry.name);
}
