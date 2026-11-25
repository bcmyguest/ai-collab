/**
 * Team files: one team.dot per team, in the project (<root>/.ai-collab/teams/<name>/team.dot) or globally
 * (<config>/ai-collab/teams/<name>/team.dot). The folder name is the team name. Writes go through a temp file and a rename.
 */
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { configDir, isValidName } from "./config.mjs";
import { readJson, withLockSync, writeFileAtomic } from "./store.ts";

export { writeFileAtomic };

export const TEAM_FILE = "team.dot";
const MIGRATED = ".migrated.json";

export const globalTeamsDir = (env) => join(configDir(env), "teams");
export const projectTeamsDir = (root) => join(root, ".ai-collab", "teams");
export const teamFilePath = (dir, name) => join(dir, name, TEAM_FILE);

/** True for a regular file. A symlink is not one: a cloned repo could point team.dot at any file on the machine. */
export function isRegularFile(file) {
  try { return lstatSync(file).isFile(); } catch { return false; }
}

/** Every valid team folder under dir that holds a regular team.dot: [{ name, file, text }], sorted by name. */
export function readTeamFiles(dir) {
  let names;
  try { names = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return names
    .filter((entry) => entry.isDirectory() && isValidName(entry.name) && isRegularFile(teamFilePath(dir, entry.name)))
    .map((entry) => ({ name: entry.name, file: teamFilePath(dir, entry.name), text: readFileSync(teamFilePath(dir, entry.name), "utf8") }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Saves a team file under its lock, synchronously; fails when another writer holds the lock past 500 ms. */
export function saveTeamFile(file, text) {
  const locked = withLockSync(file, () => writeFileAtomic(file, text), { waitMs: 500 });
  if (!locked.locked) throw new Error(`${file} is busy; retry`);
}

/** Names the one-time migration already converted (or skipped), read from the marker in the global teams folder. */
export function migratedNames(dir) {
  const value = readJson(join(dir, MIGRATED));
  return Array.isArray(value) ? value.filter((name) => typeof name === "string") : [];
}

export function recordMigrated(dir, names) {
  writeFileAtomic(join(dir, MIGRATED), `${JSON.stringify(names)}\n`);
}
