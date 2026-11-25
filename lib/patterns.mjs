/**
 * Patterns: named roles (responsibility, harness, model) and handoffs between them.
 * A handoff is required (the run cannot finish without it) or guidance (required: false, the lead may skip it).
 * Storage: a `patterns` map in the project's projects.json entry, plus global patterns.json. Legacy teams read as patterns.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir, isValidName } from "./config.mjs";
import { DOT_PROMPT_MAX, DotError, parseDot, serializeDot } from "./dot.mjs";
import { START_HARNESSES, modelShape } from "./start.mjs";
import { deleteTeam, listTeams, readProjectsFile, underProjectsLockSync, writeProjectsFile, validateMember } from "./teams.mjs";
import { globalTeamsDir, isRegularFile, projectTeamsDir, readTeamFiles, recordMigrated, migratedNames, saveTeamFile, teamFilePath, writeFileAtomic } from "./team-files.mjs";

export const DONE = "done";
export const ROLE_ID = /^[a-z][a-z0-9_-]{0,23}$/;
export const MAX_ROLES = 8;
export const RESPONSIBILITY_MAX = DOT_PROMPT_MAX;
export const EVENT_MAX = 60;
export const CAP_MAX = 10;
export const DESCRIPTION_MAX = 200;
const BUILT_IN_DIR = fileURLToPath(new URL("./team-templates/", import.meta.url));

// Shipped team templates, read from lib/team-templates/<name>/team.dot. Harnesses and models are defaults; `pattern create` with the same name overrides them.
export const BUILT_IN_PATTERNS = Object.fromEntries(readTeamFiles(BUILT_IN_DIR).map(({ name, text }) => {
  const team = parseDot(text);
  return [name, withExtras(validatePattern(patternFromTeam(team)), team)];
}));

function patternsFile(env) {
  return join(configDir(env), "patterns.json");
}

function readGlobalPatterns(env) {
  try {
    const value = JSON.parse(readFileSync(patternsFile(env), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** The entry under name, or undefined. Own keys only, so "constructor" and "__proto__" find nothing. */
function entryOf(map, name) {
  return Object.hasOwn(map, name) ? map[name] : undefined;
}

function projectPatterns(env, project) {
  const entry = readProjectsFile(env).find((item) => item?.project === project);
  const value = entry?.patterns;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Names a pattern may not take: the operator and broadcast names, DONE, harnesses, and this project's peers. */
export function reservedNames(cfg) {
  return ["all", "operator", DONE, ...START_HARNESSES, ...cfg.peers];
}

/** Team files in other registered projects: [{ name, file, text }]. This project's own files are not included. */
function otherTeamFiles(cfg, env) {
  const out = [];
  for (const entry of readProjectsFile(env)) {
    if (!entry || entry.project === cfg.project || typeof entry.root !== "string" || !entry.root) continue;
    out.push(...readTeamFiles(projectTeamsDir(entry.root)));
  }
  return out;
}

/** Another project's team, included only when exactly one other project has that name. */
function uniqueOtherTeams(cfg, env) {
  const grouped = new Map();
  for (const item of otherTeamFiles(cfg, env)) {
    const list = grouped.get(item.name) ?? [];
    list.push(item);
    grouped.set(item.name, list);
  }
  return [...grouped.values()].filter((items) => items.length === 1).map((items) => items[0]);
}

/** Every pattern name visible to a project, valid or not; teams check against this. */
export function allPatternNames(cfg, env = process.env) {
  return [...new Set([...Object.keys(BUILT_IN_PATTERNS), ...Object.keys(readGlobalPatterns(env)), ...Object.keys(projectPatterns(env, cfg.project)), ...teamFilesOf(cfg, env).map((item) => item.name), ...otherTeamFiles(cfg, env).map((item) => item.name)])];
}

/** This project's root from projects.json, or "" when the project has none. */
function projectRoot(env, project) {
  const root = readProjectsFile(env).find((item) => item?.project === project)?.root;
  return typeof root === "string" ? root : "";
}

/** Team files a project sees, global then project: [{ name, file, text, source }]. */
function teamFilesOf(cfg, env) {
  const root = projectRoot(env, cfg.project);
  return [
    ...readTeamFiles(globalTeamsDir(env)).map((item) => ({ ...item, source: "global" })),
    ...(root ? readTeamFiles(projectTeamsDir(root)).map((item) => ({ ...item, source: "project" })) : []),
  ];
}

/** A parsed team in the shape validatePattern takes: a node's prompt is its role's responsibility. */
function patternFromTeam(team) {
  const counts = new Map(team.nodes.map((node) => [node.id, node.count]));
  for (const edge of team.edges) {
    if (edge.kind === "pair" && edge.to !== DONE && counts.get(edge.from) !== counts.get(edge.to)) {
      throw new Error(`pair edge "${edge.from}" -> "${edge.to}" needs both roles to have the same count`);
    }
  }
  return {
    name: team.name,
    ...(team.description ? { description: team.description } : {}),
    roles: team.nodes.map((node) => {
      const [harness, ...rest] = node.agent.split(":");
      return { id: node.id, responsibility: node.prompt ?? "", harness, ...(rest.length ? { model: rest.join(":") } : {}) };
    }),
    handoffs: team.edges.map((edge) => ({
      from: edge.from, to: edge.to, on: edge.on, required: edge.required, ...(edge.cap !== undefined ? { cap: edge.cap } : {}),
    })),
  };
}

/** Re-attaches the DOT-only fields validatePattern drops (count, skill, fallback, code_mode, kind, max_visits); defaults stay out of the shape. */
function withExtras(checked, team) {
  const roles = checked.roles.map((role, index) => {
    const node = team.nodes[index];
    return {
      ...role,
      ...(node.count > 1 ? { count: node.count } : {}),
      ...(node.skill ? { skill: node.skill } : {}),
      ...(node.fallback ? { fallback: node.fallback } : {}),
      ...(typeof node.codeMode === "boolean" ? { codeMode: node.codeMode } : {}),
    };
  });
  const handoffs = checked.handoffs.map((handoff, index) => (team.edges[index].kind === "pair" ? handoff : { ...handoff, kind: team.edges[index].kind }));
  return { ...checked, roles, handoffs, ...(team.maxVisits ? { maxVisits: team.maxVisits } : {}) };
}

/** A validated pattern as a team, for writing a team.dot file. */
export function teamFromPattern(pattern) {
  return {
    name: pattern.name,
    description: pattern.description ?? "",
    maxVisits: pattern.maxVisits ?? null,
    nodes: pattern.roles.map((role) => ({
      id: role.id,
      agent: role.model ? `${role.harness}:${role.model}` : role.harness,
      count: role.count ?? 1,
      ...(role.skill ? { skill: role.skill } : {}),
      prompt: role.responsibility,
      ...(role.fallback ? { fallback: role.fallback } : {}),
      ...(typeof role.codeMode === "boolean" ? { codeMode: role.codeMode } : {}),
    })),
    edges: pattern.handoffs.map((handoff) => ({
      from: handoff.from, to: handoff.to, on: handoff.on, kind: handoff.kind ?? "pair", required: handoff.required,
      ...(handoff.cap !== undefined ? { cap: handoff.cap } : {}),
    })),
  };
}

/** Converts each global patterns.json entry to a team.dot once. patterns.json stays; a converted name is never converted again. */
function migrateGlobalPatterns(env) {
  const dir = globalTeamsDir(env);
  const done = migratedNames(dir);
  const pending = Object.entries(readGlobalPatterns(env)).filter(([name]) => !done.includes(name));
  if (!pending.length) return;
  const names = [...done];
  for (const [name, raw] of pending) {
    names.push(name);
    const file = teamFilePath(dir, name);
    if (existsSync(file)) continue;
    let pattern;
    try { pattern = validatePattern({ ...raw, name }); } catch { continue; }
    writeFileAtomic(file, serializeDot(teamFromPattern(pattern)));
  }
  recordMigrated(dir, names);
}

/** Throws with the node's line when a node has no prompt; validatePattern's own message carries no line. */
function checkNodePrompts(team) {
  for (const node of team.nodes) if (!node.prompt) throw new DotError(`role "${node.id}" needs a prompt`, node.line ?? null);
}

/** A team file as an entry; a file that fails to parse or validate carries `invalid` with its line. */
function checkedTeamEntry({ name, file, text, source }, reserved) {
  try {
    const team = parseDot(text);
    if (team.name !== name) throw new Error(`digraph name "${team.name}" must match the folder "${name}"`);
    checkNodePrompts(team);
    return { ...withExtras(validatePattern(patternFromTeam(team), reserved), team), source, file };
  } catch (error) {
    return { name, source, file, invalid: error.message, roles: [], handoffs: [] };
  }
}

/** A team as a pattern: one role per member, no handoffs. */
export function legacyPattern(name, members) {
  const roles = members.map((member, index) => {
    const [harness, ...rest] = String(member).split(":");
    return { id: `${harness}-${index + 1}`, responsibility: "", harness, ...(rest.length ? { model: rest.join(":") } : {}) };
  });
  return { name, legacy: true, roles, handoffs: [] };
}

/** Throws on the first structural problem; checks shape only (models are checked by validatePatternModels). */
export function validatePattern(raw, reserved = []) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("pattern must be an object");
  const { name } = raw;
  if (!isValidName(name)) throw new Error("pattern name must be 1-24 chars of a-z, 0-9 and single hyphens");
  if (reserved.includes(name)) throw new Error(`pattern name cannot be "${name}"; it is reserved`);
  if (!Array.isArray(raw.roles) || raw.roles.length < 1 || raw.roles.length > MAX_ROLES) throw new Error(`pattern needs 1-${MAX_ROLES} roles`);
  const roles = raw.roles.map((role) => {
    if (!role || typeof role !== "object") throw new Error("role must be an object");
    const id = String(role.id ?? "");
    if (!ROLE_ID.test(id) || id === DONE) throw new Error(`invalid role id "${id}"`);
    const responsibility = typeof role.responsibility === "string" ? role.responsibility.trim() : "";
    if (!responsibility || responsibility.length > RESPONSIBILITY_MAX) throw new Error(`role "${id}" needs a prompt of 1-${RESPONSIBILITY_MAX} characters`);
    if (!START_HARNESSES.includes(role.harness)) throw new Error(`role "${id}" harness must be one of ${START_HARNESSES.join(", ")}`);
    const out = { id, responsibility, harness: role.harness };
    if (role.model !== undefined && role.model !== "") {
      if (!modelShape(role.harness, String(role.model))) throw new Error(`role "${id}" has an invalid model`);
      out.model = String(role.model);
    }
    return out;
  });
  const ids = new Set(roles.map((role) => role.id));
  if (ids.size !== roles.length) throw new Error("duplicate role id");
  if (!Array.isArray(raw.handoffs) || !raw.handoffs.length) throw new Error("pattern needs at least one handoff");
  const seen = new Set();
  const handoffs = raw.handoffs.map((handoff) => {
    const from = String(handoff?.from ?? "");
    const to = String(handoff?.to ?? "");
    const on = typeof handoff?.on === "string" ? handoff.on.trim() : "";
    if (!ids.has(from)) throw new Error(`handoff from unknown role "${from}"`);
    if (!ids.has(to) && to !== DONE) throw new Error(`handoff to unknown role "${to}"`);
    if (from === to) throw new Error(`handoff from "${from}" to itself`);
    if (!on || on.length > EVENT_MAX) throw new Error(`handoff event must be 1-${EVENT_MAX} characters`);
    const key = `${from}\n${on}`;
    if (seen.has(key)) throw new Error(`role "${from}" has two handoffs on "${on}"`);
    seen.add(key);
    if (typeof handoff.required !== "boolean") throw new Error(`handoff "${from}" -> "${to}" needs required true or false`);
    const out = { from, to, on, required: handoff.required };
    if (handoff.cap !== undefined) {
      if (!Number.isInteger(handoff.cap) || handoff.cap < 1 || handoff.cap > CAP_MAX || to === DONE) throw new Error(`handoff "${on}" cap must be an integer 1-${CAP_MAX} on a role-to-role handoff`);
      out.cap = handoff.cap;
    }
    return out;
  });
  if (!handoffs.some((handoff) => handoff.to === DONE)) throw new Error(`pattern needs a handoff to "${DONE}"`);
  const reached = new Set([roles[0].id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const handoff of handoffs) {
      if (reached.has(handoff.from) && handoff.to !== DONE && !reached.has(handoff.to)) { reached.add(handoff.to); grew = true; }
    }
  }
  const stranded = roles.find((role) => !reached.has(role.id));
  if (stranded) throw new Error(`role "${stranded.id}" is not reachable from the first role "${roles[0].id}"`);
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  if (description.length > DESCRIPTION_MAX) throw new Error(`pattern description must be at most ${DESCRIPTION_MAX} characters`);
  return { name, ...(description ? { description } : {}), roles, handoffs };
}

/** Checks every role's harness and model against the allowlists (lib/models.mjs output). */
export async function validatePatternModels(pattern, cfg, env = process.env, models) {
  for (const role of pattern.roles) {
    await validateMember(role.model ? `${role.harness}:${role.model}` : role.harness, cfg, env, models);
  }
  return pattern;
}

function checkedEntry(name, raw, source, reserved) {
  try {
    return { ...validatePattern({ ...raw, name }, reserved), source };
  } catch (error) {
    return { name, source, invalid: error.message, roles: [], handoffs: [] };
  }
}

/** Merged map: built-in, then global, then another project's team, then this project's patterns and team files. Legacy teams fill names no pattern uses. Invalid saved patterns carry `invalid`. */
export function listPatterns(cfg, env = process.env) {
  try { migrateGlobalPatterns(env); } catch { /* a failed conversion leaves patterns.json as the source; the next call retries */ }
  const reserved = reservedNames(cfg);
  const files = teamFilesOf(cfg, env);
  const out = {};
  for (const [name, pattern] of Object.entries(BUILT_IN_PATTERNS)) out[name] = { ...pattern, source: "built-in" };
  for (const [name, raw] of Object.entries(readGlobalPatterns(env))) out[name] = checkedEntry(name, raw, "global", reserved);
  for (const item of files) if (item.source === "global") out[item.name] = checkedTeamEntry(item, reserved);
  // Another project's team is copyable here. A team file in this project, written below, shadows it.
  for (const item of uniqueOtherTeams(cfg, env)) {
    if (!Object.hasOwn(out, item.name)) out[item.name] = checkedTeamEntry({ ...item, source: "other" }, reserved);
  }
  for (const [name, raw] of Object.entries(projectPatterns(env, cfg.project))) out[name] = checkedEntry(name, raw, "project", reserved);
  for (const item of files) if (item.source === "project") out[item.name] = checkedTeamEntry(item, reserved);
  for (const [name, members] of Object.entries(listTeams(cfg, env))) {
    if (!out[name]) out[name] = { ...legacyPattern(name, members), source: "team" };
  }
  return out;
}

export function getPattern(cfg, name, env = process.env) {
  const pattern = entryOf(listPatterns(cfg, env), name);
  if (!pattern) throw new Error(`unknown pattern "${name}"`);
  if (pattern.invalid) throw new Error(`pattern "${name}" is invalid: ${pattern.invalid}`);
  return pattern;
}

/** Saves a pattern to the project's projects.json entry; the same name as a team is refused. */
export async function createPattern(cfg, raw, env = process.env, models) {
  const pattern = validatePattern(raw, reservedNames(cfg));
  if (entryOf(listTeams(cfg, env), pattern.name)) throw new Error(`"${pattern.name}" is a team name; pick another`);
  await validatePatternModels(pattern, cfg, env, models);
  return underProjectsLockSync(env, () => {
    if (teamFilesOf(cfg, env).some((item) => item.source === "project" && item.name === pattern.name)) {
      throw new Error(`"${pattern.name}" is a project team file; edit its team.dot instead`);
    }
    const projects = readProjectsFile(env);
    const entry = projects.find((item) => item?.project === cfg.project);
    if (!entry) throw new Error("Project is not registered in projects.json");
    const patterns = { ...projectPatterns(env, cfg.project), [pattern.name]: pattern };
    writeProjectsFile(env, projects.map((item) => (item?.project === cfg.project ? { ...item, patterns } : item)));
    return pattern;
  });
}

/**
 * Saves team.dot text as a project team: parses and checks it, then writes the canonical text under the file's lock.
 * The team's name is its folder and its digraph name; a project team shadows a global or built-in pattern of the same name.
 */
export async function saveTeamText(cfg, name, text, env = process.env, models, { create = false } = {}) {
  const root = projectRoot(env, cfg.project);
  if (!root) throw new Error("Project is not registered in projects.json");
  const { pattern } = teamOf(cfg, name, text);
  if (entryOf(listTeams(cfg, env), name)) throw new Error(`"${name}" is a team name; pick another`);
  await validatePatternModels(pattern, cfg, env, models);
  const file = teamFilePath(projectTeamsDir(root), name);
  // The text is written as the operator wrote it, comments and layout included; the parse above checked it.
  const body = text.endsWith("\n") ? text : `${text}\n`;
  if (create && entryOf(listPatterns(cfg, env), name)) throw new Error(`"${name}" already exists; pick another name or edit it`);
  // The file write awaits its own lock, so it runs outside the projects.json lock.
  await saveTeamFile(file, body);
  underProjectsLockSync(env, () => {
    // A JSON pattern of the same name is replaced by this file; drop its entry so it is not orphaned.
    const current = projectPatterns(env, cfg.project);
    if (entryOf(current, name)) {
      const patterns = { ...current };
      delete patterns[name];
      const projects = readProjectsFile(env);
      writeProjectsFile(env, projects.map((item) => (item?.project === cfg.project ? { ...item, patterns } : item)));
    }
  });
  return { ...pattern, source: "project", file };
}

/** Parses team.dot text as the team named name: the parsed team and its checked pattern. Throws with the line of a DOT error. */
function teamOf(cfg, name, text) {
  if (!isValidName(name)) throw new Error("pattern name must be 1-24 chars of a-z, 0-9 and single hyphens");
  const team = parseDot(text);
  if (team.name !== name) throw new Error(`digraph name "${team.name}" must match "${name}"`);
  checkNodePrompts(team);
  return { team, pattern: withExtras(validatePattern(patternFromTeam(team), reservedNames(cfg)), team) };
}

/** Checks team.dot text without saving it: { ok: true, pattern, warnings } or { ok: false, error, line } for the editor's live preview. */
export function checkTeamText(cfg, name, text) {
  try {
    const { team, pattern } = teamOf(cfg, name, text);
    return { ok: true, pattern, warnings: team.warnings };
  } catch (error) {
    return { ok: false, error: error.message, line: error.line ?? null };
  }
}

/** The shipped team templates the editor starts a new team from: [{ name, text }]. */
export function teamTemplates() {
  return readTeamFiles(BUILT_IN_DIR).map(({ name, text }) => ({ name, text }));
}

/** The DOT text an editor shows for a listed pattern: a team file's own text, else the canonical text of the pattern. "" when neither exists. */
export function teamTextOf(entry) {
  if (entry.file) return isRegularFile(entry.file) ? readFileSync(entry.file, "utf8") : "";
  if (entry.invalid || !entry.roles?.length) return "";
  return serializeDot(teamFromPattern(entry));
}

/** Deletes a project pattern; global and built-in patterns stay. */
export function deletePattern(cfg, name, env = process.env) {
  const pattern = entryOf(listPatterns(cfg, env), name);
  if (!pattern) throw new Error(`unknown pattern "${name}"`);
  if (pattern.file) throw new Error(`team "${name}" is a team file; delete ${pattern.file} by hand`);
  if (pattern.source !== "project") throw new Error(`pattern "${name}" is ${pattern.source}; remove it from its file`);
  return underProjectsLockSync(env, () => {
    const projects = readProjectsFile(env);
    const local = { ...projectPatterns(env, cfg.project) };
    delete local[name];
    writeProjectsFile(env, projects.map((item) => (item?.project === cfg.project ? { ...item, patterns: local } : item)));
    return { deleted: name };
  });
}

function projectEntry(cfg, env) {
  const entry = readProjectsFile(env).find((item) => item?.project === cfg.project);
  if (!entry) throw new Error("Project is not registered in projects.json");
  return entry;
}

function writeProjectEntry(cfg, env, change) {
  const projects = readProjectsFile(env);
  writeProjectsFile(env, projects.map((item) => (item?.project === cfg.project ? { ...item, ...change } : item)));
}

/**
 * Saves a pattern from the builder. With no `replace`, creates it (createPattern). With `replace` (the name the editor opened),
 * updates that project pattern in place, or converts that project team to a pattern; a new name renames it in the same write.
 */
export async function savePattern(cfg, raw, { replace = "" } = {}, env = process.env, models) {
  if (!replace) return createPattern(cfg, raw, env, models);
  const pattern = validatePattern(raw, reservedNames(cfg));
  const all = listPatterns(cfg, env);
  const old = entryOf(all, replace);
  if (!old) throw new Error(`unknown pattern "${replace}"`);
  if (old.source === "built-in" || old.source === "global") throw new Error(`${old.source} pattern "${replace}" is read-only; copy it to the project`);
  if (old.file) throw new Error(`team "${replace}" is a team file; save its team.dot text with saveTeamText`);
  const entry = projectEntry(cfg, env);
  if (old.source === "team" && !Object.hasOwn(entry.teams ?? {}, replace)) throw new Error(`team "${replace}" is global; edit it in teams.json`);
  if (pattern.name !== replace && entryOf(all, pattern.name)) throw new Error(`"${pattern.name}" already exists; pick another name`);
  await validatePatternModels(pattern, cfg, env, models);
  return underProjectsLockSync(env, () => {
    const current = projectEntry(cfg, env);
    const patterns = { ...projectPatterns(env, cfg.project) };
    const teams = { ...(current.teams ?? {}) };
    if (old.source === "project") delete patterns[replace];
    else delete teams[replace];
    patterns[pattern.name] = pattern;
    writeProjectEntry(cfg, env, { patterns, teams });
    return pattern;
  });
}

/** Names removePattern accepts in this project: its patterns and its teams (global teams live in teams.json). */
export function removableNames(cfg, env = process.env) {
  const entry = readProjectsFile(env).find((item) => item?.project === cfg.project);
  return new Set([...Object.keys(projectPatterns(env, cfg.project)), ...Object.keys(entry?.teams ?? {})]);
}

/** Deletes a project pattern or project team; built-in and global entries stay read-only. */
export function removePattern(cfg, name, env = process.env) {
  const pattern = entryOf(listPatterns(cfg, env), name);
  if (pattern?.source === "team") return deleteTeam(cfg, name, env);
  return deletePattern(cfg, name, env);
}

/**
 * Copies a built-in, global, or another project's team into this project under the same name.
 * The copy is a team file in this project. The source file is read and not written.
 */
export async function copyPattern(cfg, name, env = process.env, models) {
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

/** Required handoffs: the run finishes only after each has fired. */
export function requiredHandoffs(pattern) {
  return pattern.handoffs.filter((handoff) => handoff.required);
}
