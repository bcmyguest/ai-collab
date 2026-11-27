/** Team files: one team.dot per team, in <root>/.ai-collab/teams/<name>/ or <config>/ai-collab/teams/<name>/. The folder name is the team name. */
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { configDir, isValidName } from "../config.ts";
import { readJson, withLockSync, writeFileAtomic, writeJson } from "../store.ts";

const TEAM_FILE = "team.dot";
const MIGRATED = ".migrated.json";
// Waits for a save's lock this long before failing; the lock guards one file write.
const SAVE_WAIT_MS = 500;

export type TeamFile = { name: string; file: string; text: string };

export const globalTeamsDir = (env: NodeJS.ProcessEnv): string => join(configDir(env), "teams");
export const projectTeamsDir = (root: string): string => join(root, ".ai-collab", "teams");
export const teamFilePath = (dir: string, name: string): string => join(dir, name, TEAM_FILE);

/** True for a regular file. A symlink is not one: a cloned repo could point team.dot at any file on the machine. */
export function isRegularFile(file: string): boolean {
  try { return lstatSync(file).isFile(); } catch { return false; }
}

/** Every valid team folder under dir that holds a regular team.dot, sorted by name. */
export function readTeamFiles(dir: string): TeamFile[] {
  let names;
  try { names = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return names
    .filter((entry) => entry.isDirectory() && isValidName(entry.name) && isRegularFile(teamFilePath(dir, entry.name)))
    .map((entry) => ({ name: entry.name, file: teamFilePath(dir, entry.name), text: readFileSync(teamFilePath(dir, entry.name), "utf8") }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Saves a team file under its lock; fails when another writer holds the lock past 500 ms. */
export function saveTeamFile(file: string, text: string): void {
  const locked = withLockSync(file, () => writeFileAtomic(file, text), { waitMs: SAVE_WAIT_MS });
  if (!locked.locked) throw new Error(`${file} is busy; retry`);
}

/** Names the one-time migration already converted (or skipped), read from the marker in the global teams folder. */
export function migratedNames(dir: string): string[] {
  const value = readJson<unknown>(join(dir, MIGRATED));
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
}

export function recordMigrated(dir: string, names: string[]): void {
  writeJson(join(dir, MIGRATED), names);
}
