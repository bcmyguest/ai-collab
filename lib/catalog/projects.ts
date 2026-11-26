/** projects.json: the registered projects with their teams and patterns. Every write holds the projects.json lock. */
import { join } from "node:path";
import { configDir } from "../config.mjs";
import { readJson, withLockSync, writeJson } from "../store.ts";
import type { Pattern, ProjectEntry } from "./records.ts";

const NOT_REGISTERED = "Project is not registered in projects.json";
const LOCK_WAIT_MS = 2000;

type Env = NodeJS.ProcessEnv;
type WithStatus = { status?: number };

function projectsFile(env: Env): string {
  return join(configDir(env), "projects.json");
}

/** The object at value, or {} when it is missing, an array, or not an object. */
export function plainMap<T>(value: unknown): Record<string, T> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, T>) : {};
}

/** The entry's team map: name to member strings. */
export function entryTeams(entry: ProjectEntry | undefined): Record<string, string[]> {
  return plainMap<string[]>(entry?.teams);
}

/** The entry's pattern map: name to pattern. */
export function entryPatterns(entry: ProjectEntry | undefined): Record<string, Pattern> {
  return plainMap<Pattern>(entry?.patterns);
}

export function readProjectsFile(env: Env): ProjectEntry[] {
  const value = readJson<ProjectEntry[]>(projectsFile(env));
  return Array.isArray(value) ? value : [];
}

/** Writes projects.json through a temp file and rename, indented two spaces. Callers hold the lock. */
export function writeProjectsFile(env: Env, projects: ProjectEntry[]): void {
  writeJson(projectsFile(env), projects, { indent: 2 });
}

/** Runs fn holding the projects.json lock; throws when another writer holds it for 2 s. */
function underProjectsLockSync<T>(env: Env, fn: () => T): T {
  const locked = withLockSync(projectsFile(env), fn, { waitMs: LOCK_WAIT_MS });
  if (!locked.locked) throw new Error("projects.json is busy; retry");
  return locked.value;
}

/** Read-modify-write of the whole list under the lock: fn returns the next list (omit it to skip the write) and a result. */
export function updateProjects<T>(env: Env, fn: (projects: ProjectEntry[]) => { projects?: ProjectEntry[]; result: T }): T {
  return underProjectsLockSync(env, () => {
    const change = fn(readProjectsFile(env));
    if (change.projects) writeProjectsFile(env, change.projects);
    return change.result;
  });
}

/** Read-modify-write of one registered entry under the lock; a missing entry throws, with `status` when given. */
export function updateProject<T>(env: Env, project: string, change: (entry: ProjectEntry) => { entry: ProjectEntry; result: T }, { status }: WithStatus = {}): T {
  return updateProjects(env, (projects) => {
    const index = projects.findIndex((entry) => entry?.project === project);
    if (index < 0) throw Object.assign(new Error(NOT_REGISTERED), status ? { status } : {});
    const { entry, result } = change(projects[index]);
    const next = projects.slice();
    next[index] = entry;
    return { projects: next, result };
  });
}

export function findProject(env: Env, project: string): ProjectEntry | undefined {
  return readProjectsFile(env).find((entry) => entry?.project === project);
}

/** The registered entry; throws when the project is not in projects.json. */
export function requireProject(env: Env, project: string): ProjectEntry {
  const entry = findProject(env, project);
  if (!entry) throw new Error(NOT_REGISTERED);
  return entry;
}

/** Marks a registered project closed or open; its repo, worktrees and ntfy history stay. */
export function setProjectClosed(env: Env, project: string, closed: boolean): void {
  updateProject(env, project, (entry) => ({ entry: { ...entry, closed }, result: undefined }), { status: 404 });
}

/** Removes a project's projects.json entry; its repo, worktrees and ntfy history stay. */
export function removeProject(env: Env, project: string): void {
  updateProjects(env, (projects) => {
    if (!projects.some((entry) => entry?.project === project)) throw Object.assign(new Error(NOT_REGISTERED), { status: 404 });
    return { projects: projects.filter((entry) => entry?.project !== project), result: undefined };
  });
}

/** Names of the registered projects marked closed. */
export function closedProjectNames(env: Env): string[] {
  return readProjectsFile(env).filter((entry) => entry?.closed === true).map((entry) => entry.project);
}
