// Phone alert level: which notifications buzz. Messages always arrive; a level silences the rest with ntfy priority 1.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config.mjs";

export const ALERT_LEVELS = ["all", "questions-and-direct", "questions", "none"];
export const DEFAULT_ALERT_LEVEL = "all";
// ntfy priority of a silent notification: listed in the app, no sound or vibration.
const SILENT_PRIORITY = 1;

/** Kinds: question (ask_question, terminal questions, approvals), direct (agent replies to the operator), other (status, receipts, mode, usage). */
export function buzzes(level, kind) {
  if (level === "all") return true;
  if (level === "none") return false;
  if (level === "questions") return kind === "question";
  return kind === "question" || kind === "direct";
}

/** The ntfy priority for a publish: its own when it buzzes at this level, else the silent priority. */
export function alertPriority(level, kind, priority) {
  return buzzes(level, kind) ? priority : SILENT_PRIORITY;
}

function alertsFile(env) {
  return join(configDir(env), "alerts.json");
}

/** The stored level; the default when the file is missing, unreadable or names no level. */
export function readAlertLevel(env = process.env) {
  try {
    const level = JSON.parse(readFileSync(alertsFile(env), "utf8"))?.level;
    return ALERT_LEVELS.includes(level) ? level : DEFAULT_ALERT_LEVEL;
  } catch {
    return DEFAULT_ALERT_LEVEL;
  }
}

/** Stores the level through a temp file and rename; throws on a level outside ALERT_LEVELS. */
export function writeAlertLevel(env, level) {
  if (!ALERT_LEVELS.includes(level)) throw Object.assign(new Error("Alert level must be " + ALERT_LEVELS.join(", ")), { status: 400 });
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = alertsFile(env);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ level })}\n`, { mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
