// Phone alert level: which notifications buzz. Messages always arrive; a level silences the rest with wire priority 1.
import { join } from "node:path";
import { configDir } from "./config.mjs";
import { readJson, writeJson } from "./store.ts";

export const ALERT_LEVELS = ["all", "questions-and-direct", "questions", "none"];
export const DEFAULT_ALERT_LEVEL = "all";
// Wire priority of a silent notification: listed in the app, no sound or vibration.
const SILENT_PRIORITY = 1;

/** Kinds: question (ask_question, terminal questions, approvals), direct (agent replies to the operator), other (status, receipts, mode, usage). */
export function buzzes(level, kind) {
  if (level === "all") return true;
  if (level === "none") return false;
  if (level === "questions") return kind === "question";
  return kind === "question" || kind === "direct";
}

/** The wire priority for a publish: its own when it buzzes at this level, else the silent priority. */
export function alertPriority(level, kind, priority) {
  return buzzes(level, kind) ? priority : SILENT_PRIORITY;
}

function alertsFile(env) {
  return join(configDir(env), "alerts.json");
}

/** The stored level; the default when the file is missing, unreadable or names no level. */
export function readAlertLevel(env = process.env) {
  const level = readJson(alertsFile(env))?.level;
  return ALERT_LEVELS.includes(level) ? level : DEFAULT_ALERT_LEVEL;
}

/** Stores the level atomically; throws on a level outside ALERT_LEVELS. */
export function writeAlertLevel(env, level) {
  if (!ALERT_LEVELS.includes(level)) throw Object.assign(new Error("Alert level must be " + ALERT_LEVELS.join(", ")), { status: 400 });
  writeJson(alertsFile(env), { level });
}
