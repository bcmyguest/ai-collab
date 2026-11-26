/** Patterns: storage, listing and saving. Sources merge as built-in, global, other project, project; legacy teams fill the rest. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir, isValidName } from "../config.mjs";
import { readJson, writeFileAtomic } from "../store.ts";
import { parseDot, serializeDot, type DotTeam } from "./dot.ts";
import { deleteTeam, listTeams, validateMember, type Models } from "./teams.ts";
import { entryPatterns, entryTeams, findProject, readProjectsFile, requireProject, updateProject, updateProjects } from "./projects.ts";
import { globalTeamsDir, isRegularFile, migratedNames, projectTeamsDir, readTeamFiles, recordMigrated, saveTeamFile, teamFilePath, type TeamFile } from "./team-files.ts";
import { checkNodePrompts, legacyPattern, patternFromTeam, reservedNames, teamFromPattern, validatePattern, withExtras } from "./pattern-model.ts";
import type { CatalogConfig, Pattern, PatternSource } from "./records.ts";

type Loose = Record<string, any>;
type Env = NodeJS.ProcessEnv;
type CheckResult = { ok: true; pattern: Pattern; warnings: DotTeam["warnings"] } | { ok: false; error: string; line: number | null };

const BUILT_IN_DIR = fileURLToPath(new URL("../team-templates/", import.meta.url));

// Shipped team templates, read from lib/team-templates/<name>/team.dot. Harnesses and models are defaults; `pattern create` with the same name overrides them.
// Test and tool use only: callers list patterns through listPatterns.
export const BUILT_IN_PATTERNS: Record<string, Pattern> = Object.fromEntries(readTeamFiles(BUILT_IN_DIR).map(({ name, text }) => {
  const team = parseDot(text);
  return [name, withExtras(validatePattern(patternFromTeam(team)), team)];
}));

function patternsFile(env: Env): string {
  return join(configDir(env), "patterns.json");
}

function readGlobalPatterns(env: Env): Record<string, Loose> {
  const value = readJson<unknown>(patternsFile(env));
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Loose>) : {};
}

/** The entry under name, or undefined. Own keys only, so "constructor" and "__proto__" find nothing. */
function entryOf<T>(map: Record<string, T>, name: string): T | undefined {
  return Object.hasOwn(map, name) ? map[name] : undefined;
}

/** Team files in other registered projects: this project's own files are not included. */
function otherTeamFiles(cfg: CatalogConfig, env: Env): TeamFile[] {
  const out: TeamFile[] = [];
  for (const entry of readProjectsFile(env)) {
    if (!entry || entry.project === cfg.project || typeof entry.root !== "string" || !entry.root) continue;
    out.push(...readTeamFiles(projectTeamsDir(entry.root)));
  }
  return out;
}

/** Another project's team, included only when exactly one other project has that name. */
function uniqueOtherTeams(cfg: CatalogConfig, env: Env): TeamFile[] {
  const grouped = new Map<string, TeamFile[]>();
  for (const item of otherTeamFiles(cfg, env)) {
    const list = grouped.get(item.name) ?? [];
    list.push(item);
    grouped.set(item.name, list);
  }
  return [...grouped.values()].filter((items) => items.length === 1).map((items) => items[0]);
}

/** Every pattern name visible to a project, valid or not; teams check against this. */
export function allPatternNames(cfg: CatalogConfig, env: Env = process.env): string[] {
  return [...new Set([
    ...Object.keys(BUILT_IN_PATTERNS),
    ...Object.keys(readGlobalPatterns(env)),
    ...Object.keys(entryPatterns(findProject(env, cfg.project))),
    ...teamFilesOf(cfg, env).map((item) => item.name),
    ...otherTeamFiles(cfg, env).map((item) => item.name),
  ])];
}

/** This project's root from projects.json, or "" when the project has none. */
function projectRoot(env: Env, project: string): string {
  const root = findProject(env, project)?.root;
  return typeof root === "string" ? root : "";
}

/** Team files a project sees, global then project. */
function teamFilesOf(cfg: CatalogConfig, env: Env): Array<TeamFile & { source: "global" | "project" }> {
  const root = projectRoot(env, cfg.project);
  return [
    ...readTeamFiles(globalTeamsDir(env)).map((item) => ({ ...item, source: "global" as const })),
    ...(root ? readTeamFiles(projectTeamsDir(root)).map((item) => ({ ...item, source: "project" as const })) : []),
  ];
}

/** Converts each global patterns.json entry to a team.dot once. patterns.json stays; a converted name is never converted again. */
function migrateGlobalPatterns(env: Env): void {
  const dir = globalTeamsDir(env);
  const done = migratedNames(dir);
  const pending = Object.entries(readGlobalPatterns(env)).filter(([name]) => !done.includes(name));
  if (!pending.length) return;
  const names = [...done];
  for (const [name, raw] of pending) {
    names.push(name);
    const file = teamFilePath(dir, name);
    if (existsSync(file)) continue;
    let pattern: Pattern;
    try { pattern = validatePattern({ ...raw, name }); } catch { continue; }
    writeFileAtomic(file, serializeDot(teamFromPattern(pattern)));
  }
  recordMigrated(dir, names);
}

/** A team file as a pattern entry; a file that fails to parse or validate carries `invalid` with its line. */
function checkedTeamEntry({ name, file, text, source }: TeamFile & { source: PatternSource }, reserved: string[]): Pattern {
  try {
    const team = parseDot(text);
    if (team.name !== name) throw new Error(`digraph name "${team.name}" must match the folder "${name}"`);
    checkNodePrompts(team);
    return { ...withExtras(validatePattern(patternFromTeam(team), reserved), team), source, file };
  } catch (error) {
    return { name, source, file, invalid: (error as Error).message, roles: [], handoffs: [] };
  }
}

function checkedEntry(name: string, raw: Loose, source: PatternSource, reserved: string[]): Pattern {
  try {
    return { ...validatePattern({ ...raw, name }, reserved), source };
  } catch (error) {
    return { name, source, invalid: (error as Error).message, roles: [], handoffs: [] };
  }
}

/** Merged map: built-in, then global, then another project's team, then this project's patterns and team files. Legacy teams fill names no pattern uses. Invalid saved patterns carry `invalid`. */
export function listPatterns(cfg: CatalogConfig, env: Env = process.env): Record<string, Pattern> {
  try { migrateGlobalPatterns(env); } catch { /* a failed conversion leaves patterns.json as the source; the next call retries */ }
  const reserved = reservedNames(cfg);
  const files = teamFilesOf(cfg, env);
  const out: Record<string, Pattern> = {};
  for (const [name, pattern] of Object.entries(BUILT_IN_PATTERNS)) out[name] = { ...pattern, source: "built-in" };
  for (const [name, raw] of Object.entries(readGlobalPatterns(env))) out[name] = checkedEntry(name, raw, "global", reserved);
  for (const item of files) if (item.source === "global") out[item.name] = checkedTeamEntry({ ...item, source: "global" }, reserved);
  // Another project's team is copyable here. A team file in this project, written below, shadows it.
  for (const item of uniqueOtherTeams(cfg, env)) {
    if (!Object.hasOwn(out, item.name)) out[item.name] = checkedTeamEntry({ ...item, source: "other" }, reserved);
  }
  for (const [name, raw] of Object.entries(entryPatterns(findProject(env, cfg.project)))) out[name] = checkedEntry(name, raw as Loose, "project", reserved);
  for (const item of files) if (item.source === "project") out[item.name] = checkedTeamEntry({ ...item, source: "project" }, reserved);
  for (const [name, members] of Object.entries(listTeams(cfg, env))) {
    if (!out[name]) out[name] = { ...legacyPattern(name, members), source: "team" };
  }
  return out;
}

export function getPattern(cfg: CatalogConfig, name: string, env: Env = process.env): Pattern {
  const pattern = entryOf(listPatterns(cfg, env), name);
  if (!pattern) throw new Error(`unknown pattern "${name}"`);
  if (pattern.invalid) throw new Error(`pattern "${name}" is invalid: ${pattern.invalid}`);
  return pattern;
}

/** Checks every role's harness and model against the allowlists (lib/models.mjs output). */
export async function validatePatternModels(pattern: Pattern, cfg: CatalogConfig, env: Env = process.env, models?: Models): Promise<Pattern> {
  for (const role of pattern.roles) {
    await validateMember(role.model ? `${role.harness}:${role.model}` : role.harness, cfg, env, models);
  }
  return pattern;
}

/** Saves a pattern to the project's projects.json entry; the same name as a team is refused. */
export async function createPattern(cfg: CatalogConfig, raw: unknown, env: Env = process.env, models?: Models): Promise<Pattern> {
  const pattern = validatePattern(raw, reservedNames(cfg));
  if (entryOf(listTeams(cfg, env), pattern.name)) throw new Error(`"${pattern.name}" is a team name; pick another`);
  await validatePatternModels(pattern, cfg, env, models);
  return updateProject(env, cfg.project, (entry) => {
    if (teamFilesOf(cfg, env).some((item) => item.source === "project" && item.name === pattern.name)) {
      throw new Error(`"${pattern.name}" is a project team file; edit its team.dot instead`);
    }
    return { entry: { ...entry, patterns: { ...entryPatterns(entry), [pattern.name]: pattern } }, result: pattern };
  });
}

/** Parses team.dot text as the team named name: the parsed team and its checked pattern. Throws with the line of a DOT error. */
function teamOf(cfg: CatalogConfig, name: string, text: string): { team: DotTeam; pattern: Pattern } {
  if (!isValidName(name)) throw new Error("pattern name must be 1-24 chars of a-z, 0-9 and single hyphens");
  const team = parseDot(text);
  if (team.name !== name) throw new Error(`digraph name "${team.name}" must match "${name}"`);
  checkNodePrompts(team);
  return { team, pattern: withExtras(validatePattern(patternFromTeam(team), reservedNames(cfg)), team) };
}

/** Checks team.dot text without saving it, for the editor's live preview. */
export function checkTeamText(cfg: CatalogConfig, name: string, text: string): CheckResult {
  try {
    const { team, pattern } = teamOf(cfg, name, text);
    return { ok: true, pattern, warnings: team.warnings };
  } catch (error) {
    return { ok: false, error: (error as Error).message, line: (error as { line?: number | null }).line ?? null };
  }
}

/**
 * Saves team.dot text as a project team: parses and checks it, then writes the canonical text under the file's lock.
 * The team's name is its folder and its digraph name; a project team shadows a global or built-in pattern of the same name.
 * Lock order: projects.json first, then the team file.
 */
export async function saveTeamText(cfg: CatalogConfig, name: string, text: string, env: Env = process.env, models?: Models, { create = false }: { create?: boolean } = {}): Promise<Pattern> {
  const root = projectRoot(env, cfg.project);
  if (!root) throw new Error("Project is not registered in projects.json");
  const { pattern } = teamOf(cfg, name, text);
  if (entryOf(listTeams(cfg, env), name)) throw new Error(`"${name}" is a team name; pick another`);
  await validatePatternModels(pattern, cfg, env, models);
  const file = teamFilePath(projectTeamsDir(root), name);
  // The text is written as the operator wrote it, comments and layout included; the parse above checked it.
  const body = text.endsWith("\n") ? text : `${text}\n`;
  // The name check and the file write share the projects.json lock, so two creates of one name cannot both pass the check.
  updateProjects(env, (projects) => {
    if (create && entryOf(listPatterns(cfg, env), name)) throw new Error(`"${name}" already exists; pick another name or edit it`);
    saveTeamFile(file, body);
    // A JSON pattern of the same name is replaced by this file; drop its entry so it is not orphaned.
    const current = entryPatterns(projects.find((item) => item?.project === cfg.project));
    if (!entryOf(current, name)) return { result: undefined };
    const patterns = { ...current };
    delete patterns[name];
    return { projects: projects.map((item) => (item?.project === cfg.project ? { ...item, patterns } : item)), result: undefined };
  });
  return { ...pattern, source: "project", file };
}

/** The shipped team templates the editor starts a new team from: [{ name, text }]. */
export function teamTemplates(): Array<{ name: string; text: string }> {
  return readTeamFiles(BUILT_IN_DIR).map(({ name, text }) => ({ name, text }));
}

/** The DOT text an editor shows for a listed pattern: a team file's own text, else the canonical text of the pattern. "" when neither exists. */
export function teamTextOf(entry: Pattern): string {
  if (entry.file) return isRegularFile(entry.file) ? readFileSync(entry.file, "utf8") : "";
  if (entry.invalid || !entry.roles?.length) return "";
  return serializeDot(teamFromPattern(entry));
}

/** Deletes a project pattern; global and built-in patterns stay. */
export function deletePattern(cfg: CatalogConfig, name: string, env: Env = process.env): { deleted: string } {
  const pattern = entryOf(listPatterns(cfg, env), name);
  if (!pattern) throw new Error(`unknown pattern "${name}"`);
  if (pattern.file) throw new Error(`team "${name}" is a team file; delete ${pattern.file} by hand`);
  if (pattern.source !== "project") throw new Error(`pattern "${name}" is ${pattern.source}; remove it from its file`);
  return updateProject(env, cfg.project, (entry) => {
    const local = { ...entryPatterns(entry) };
    delete local[name];
    return { entry: { ...entry, patterns: local }, result: { deleted: name } };
  });
}

/**
 * Saves a pattern from the builder. With no `replace`, creates it (createPattern). With `replace` (the name the editor opened),
 * updates that project pattern in place, or converts that project team to a pattern; a new name renames it in the same write.
 */
export async function savePattern(cfg: CatalogConfig, raw: unknown, { replace = "" }: { replace?: string } = {}, env: Env = process.env, models?: Models): Promise<Pattern> {
  if (!replace) return createPattern(cfg, raw, env, models);
  const pattern = validatePattern(raw, reservedNames(cfg));
  const all = listPatterns(cfg, env);
  const old = entryOf(all, replace);
  if (!old) throw new Error(`unknown pattern "${replace}"`);
  if (old.source === "built-in" || old.source === "global") throw new Error(`${old.source} pattern "${replace}" is read-only; copy it to the project`);
  if (old.file) throw new Error(`team "${replace}" is a team file; save its team.dot text with saveTeamText`);
  const entry = requireProject(env, cfg.project);
  if (old.source === "team" && !Object.hasOwn(entryTeams(entry), replace)) throw new Error(`team "${replace}" is global; edit it in teams.json`);
  if (pattern.name !== replace && entryOf(all, pattern.name)) throw new Error(`"${pattern.name}" already exists; pick another name`);
  await validatePatternModels(pattern, cfg, env, models);
  return updateProject(env, cfg.project, (current) => {
    const patterns = { ...entryPatterns(current) };
    const teams = { ...entryTeams(current) };
    if (old.source === "project") delete patterns[replace];
    else delete teams[replace];
    patterns[pattern.name] = pattern;
    return { entry: { ...current, patterns, teams }, result: pattern };
  });
}

/** Names removePattern accepts in this project: its patterns and its teams (global teams live in teams.json). */
export function removableNames(cfg: CatalogConfig, env: Env = process.env): Set<string> {
  const entry = findProject(env, cfg.project);
  return new Set([...Object.keys(entryPatterns(entry)), ...Object.keys(entryTeams(entry))]);
}

/** Deletes a project pattern or project team; built-in and global entries stay read-only. */
export function removePattern(cfg: CatalogConfig, name: string, env: Env = process.env): { deleted: string } {
  const pattern = entryOf(listPatterns(cfg, env), name);
  if (pattern?.source === "team") return deleteTeam(cfg, name, env);
  return deletePattern(cfg, name, env);
}

/**
 * Copies a built-in, global, or another project's team into this project under the same name.
 * The copy is a team file in this project. The source file is read and not written.
 */
export async function copyPattern(cfg: CatalogConfig, name: string, env: Env = process.env, models?: Models): Promise<Pattern> {
  let source = entryOf(listPatterns(cfg, env), name);
  if (!source) {
    const found = otherTeamFiles(cfg, env).filter((item) => item.name === name);
    if (found.length > 1) throw new Error(`pattern "${name}" is in more than one project`);
    if (found.length === 1) source = checkedTeamEntry({ ...found[0], source: "other" }, reservedNames(cfg));
  }
  if (!source) throw new Error(`unknown pattern "${name}"`);
  if (source.source !== "built-in" && source.source !== "global" && source.source !== "other") throw new Error(`pattern "${name}" is already ${source.source}`);
  if (source.invalid) throw new Error(`pattern "${name}" is invalid: ${source.invalid}`);
  // A team file copies as its DOT text, which keeps every field; a JSON pattern copies its shape.
  if (source.file) return saveTeamText(cfg, name, readFileSync(source.file, "utf8"), env, models);
  return createPattern(cfg, { name, ...(source.description ? { description: source.description } : {}), roles: source.roles, handoffs: source.handoffs }, env, models);
}
