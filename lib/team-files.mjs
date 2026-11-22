/**
 * Team files: one team.dot per team, in the project (<root>/.ai-collab/teams/<name>/team.dot) or globally
 * (<config>/ai-collab/teams/<name>/team.dot). The folder name is the team name. Writes go through a temp file and a rename.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, isValidName } from "./config.mjs";
import { withLock } from "./state.mjs";

export const TEAM_FILE = "team.dot";
const MIGRATED = ".migrated.json";

export const globalTeamsDir = (env) => join(configDir(env), "teams");
export const projectTeamsDir = (root) => join(root, ".ai-collab", "teams");
export const teamFilePath = (dir, name) => join(dir, name, TEAM_FILE);

/** Every valid team folder under dir that holds a team.dot: [{ name, file, text }], sorted by name. */
export function readTeamFiles(dir) {
  let names;
  try { names = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return names
    .filter((entry) => entry.isDirectory() && isValidName(entry.name) && existsSync(teamFilePath(dir, entry.name)))
    .map((entry) => ({ name: entry.name, file: teamFilePath(dir, entry.name), text: readFileSync(teamFilePath(dir, entry.name), "utf8") }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Writes text to file through a temp file and a rename, so a reader never sees a partial file. */
export function writeFileAtomic(file, text) {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Saves a team file under its lock; the lock fails when another writer holds it past waitMs. */
export async function saveTeamFile(file, text) {
  const locked = await withLock(file, () => writeFileAtomic(file, text), { waitMs: 5000 });
  if (!locked.locked) throw new Error(`${file} is busy; retry`);
}

/** Names the one-time migration already converted (or skipped), read from the marker in the global teams folder. */
export function migratedNames(dir) {
  try {
    const value = JSON.parse(readFileSync(join(dir, MIGRATED), "utf8"));
    return Array.isArray(value) ? value.filter((name) => typeof name === "string") : [];
  } catch {
    return [];
  }
}

export function recordMigrated(dir, names) {
  writeFileAtomic(join(dir, MIGRATED), `${JSON.stringify(names)}\n`);
}
