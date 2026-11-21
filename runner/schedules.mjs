// Scheduled commands: schedules.json entries become durable scheduled workflows that run one command per tick.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { configDir } from "../lib/config.mjs";
import { childEnv } from "../lib/start.mjs";

export const DEFAULT_TIMEOUT_SEC = 900;
export const TAIL_CHARS = 2000;
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
  if (!Number.isSafeInteger(entry.everyMinutes) || entry.everyMinutes < 1) invalid(index, "everyMinutes must be a positive integer");
  if (typeof entry.cwd !== "string" || !isAbsolute(entry.cwd)) invalid(index, "cwd must be an absolute path");
  if (!Array.isArray(entry.command) || !entry.command.length || !entry.command.every((arg) => typeof arg === "string") || !entry.command[0]) {
    invalid(index, "command must be a non-empty array of strings");
  }
  const timeoutSec = entry.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  if (!Number.isSafeInteger(timeoutSec) || timeoutSec < 1) invalid(index, "timeoutSec must be a positive integer");
  return { name: entry.name, everyMs: entry.everyMinutes * 60_000, cwd: entry.cwd, command: entry.command, timeoutMs: timeoutSec * 1000 };
}

/** Reads and checks the schedules file; a missing file is no schedules. Throws on any invalid entry. */
export function loadSchedules(env = process.env) {
  const file = schedulesPath(env);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  let list;
  try {
    list = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(list)) throw new Error(`${file} must hold a JSON array of schedules`);
  const entries = list.map(checkEntry);
  const names = new Set();
  for (const entry of entries) {
    if (names.has(entry.name)) throw new Error(`${file}: schedule ${entry.name} appears twice`);
    names.add(entry.name);
  }
  return entries;
}

/** Runs argv with execFile (no shell); resolves {ok, exitCode, timedOut, durationMs, tail}. Rejects when signal aborts, after killing the child. */
export function runCommand(command, { cwd, env = process.env, timeoutMs, signal }) {
  const [file, ...args] = command;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { cwd, env, timeout: timeoutMs, killSignal: "SIGTERM", maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (signal?.aborted) return reject(signal.reason);
      const text = error && !stdout && !stderr ? error.message : `${stdout}${stderr}`;
      resolve({
        ok: !error,
        exitCode: error ? (Number.isInteger(error.code) ? error.code : null) : 0,
        timedOut: Boolean(error?.killed),
        durationMs: Date.now() - started,
        tail: text.slice(-TAIL_CHARS),
      });
    });
    signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
  });
}

/** The workflow body for one entry: one checkpointed command step, not re-run after a cut. */
export function tickFn(entry, { env = process.env, log = () => {} } = {}) {
  return async (scheduledTime, actualTime, wf) => {
    const result = await wf.step("command", () => runCommand(entry.command, { cwd: entry.cwd, env: childEnv(env), timeoutMs: entry.timeoutMs, signal: wf.signal }), {
      onCut: () => ({ ok: false, exitCode: null, timedOut: false, durationMs: 0, tail: "", cut: "runner restarted during the run; not re-run" }),
    });
    log(`${entry.name}: ${result.ok ? "ok" : "failed"}${result.timedOut ? " (timed out)" : ""} in ${result.durationMs} ms`);
    return { ...result, scheduledTime: scheduledTime.toISOString(), actualTime: actualTime.toISOString() };
  };
}

/** Registers each entry with the durable log as a scheduled workflow; returns the names. */
export function registerSchedules(durable, entries, { env = process.env, log = () => {} } = {}) {
  for (const entry of entries) durable.scheduled(entry.name, { everyMs: entry.everyMs }, tickFn(entry, { env, log }));
  return entries.map((entry) => entry.name);
}
