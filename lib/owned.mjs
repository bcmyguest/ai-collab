// Owned-session registry, written by the runner and read by hooks to stand down (docs/owned-sessions-contract.md).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SESSION_LABEL } from "./config.mjs";
import { writeState } from "./state.mjs";

export const OWNED_ENV = "AI_COLLAB_OWNED";
export const OWNED_STATUSES = ["starting", "idle", "running", "ended"];
const LABEL_FILE = /^[a-f0-9]{16}\.json$/;

export function ownedDir(cfg) {
  return join(cfg.stateDir, cfg.project, "owned");
}

export function ownedFile(cfg, label) {
  if (!SESSION_LABEL.test(label || "")) throw new Error("invalid session label");
  return join(ownedDir(cfg), `${label}.json`);
}

/** The owned record for a session label, or null when absent or unreadable. */
export function readOwned(cfg, label) {
  if (!SESSION_LABEL.test(label || "")) return null;
  try {
    const record = JSON.parse(readFileSync(ownedFile(cfg, label), "utf8"));
    return record && record.v === 1 && record.label === label ? record : null;
  } catch {
    return null;
  }
}

/** Writes the record atomically (0600 file in a 0700 dir). */
export function writeOwned(cfg, record) {
  writeState(ownedFile(cfg, record.label), { ...record, v: 1, updatedAt: Date.now() });
}

/** Every readable owned record of this project. */
export function listOwned(cfg) {
  let files;
  try { files = readdirSync(ownedDir(cfg)); } catch { return []; }
  return files.filter((file) => LABEL_FILE.test(file)).map((file) => readOwned(cfg, file.slice(0, -5))).filter(Boolean);
}

/** True when the label has a live owned record, or the runner spawned this host's process (AI_COLLAB_OWNED=<harness>). */
export function standsDown(cfg, { host, label, env = process.env }) {
  if (env[OWNED_ENV] && env[OWNED_ENV] === host) return true;
  if (!cfg?.stateDir || !cfg.project || !SESSION_LABEL.test(label || "")) return false;
  if (!existsSync(join(ownedDir(cfg), `${label}.json`))) return false;
  const record = readOwned(cfg, label);
  return Boolean(record && record.status !== "ended");
}
