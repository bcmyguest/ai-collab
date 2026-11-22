/**
 * Patterns: named roles (responsibility, harness, model) and handoffs between them.
 * A handoff is required (the run cannot finish without it) or guidance (the lead may skip it).
 * Storage: a `patterns` map in the project's projects.json entry, plus global patterns.json. Legacy teams read as patterns.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, isValidName } from "./config.mjs";
import { START_HARNESSES, modelShape } from "./start.mjs";
import { listTeams, readProjectsFile, writeProjectsFile, validateMember } from "./teams.mjs";

export const DONE = "done";
export const ROLE_ID = /^[a-z][a-z0-9-]{0,23}$/;
export const MAX_ROLES = 8;
export const RESPONSIBILITY_MAX = 1000;
export const EVENT_MAX = 60;
export const CAP_MAX = 10;

// Shipped pattern. Harnesses are defaults; `pattern create` with the same name overrides them.
export const BUILT_IN_PATTERNS = {
  "fix-and-review": {
    name: "fix-and-review",
    roles: [
      { id: "lead", responsibility: "Scope the task into one change with acceptance criteria. Hand off to the implementer.", harness: "claude" },
      { id: "implementer", responsibility: "Edit the code and add or run tests. Hand off the diff and test results to the reviewer.", harness: "claude" },
      { id: "reviewer", responsibility: "Review the diff against the scope. Approve, or request changes with specific points.", harness: "claude" },
    ],
    handoffs: [
      { from: "lead", to: "implementer", on: "scope", required: false },
      { from: "implementer", to: "reviewer", on: "diff and test results", required: true },
      { from: "reviewer", to: "implementer", on: "changes requested", required: false, cap: 3 },
      { from: "reviewer", to: "lead", on: "approved", required: true },
      { from: "lead", to: DONE, on: "finished", required: false },
    ],
  },
};

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

function projectPatterns(env, project) {
  const entry = readProjectsFile(env).find((item) => item?.project === project);
  const value = entry?.patterns;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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
export function validatePattern(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("pattern must be an object");
  const { name } = raw;
  if (!isValidName(name)) throw new Error("pattern name must be 1-24 chars of a-z, 0-9 and single hyphens");
  if (name === "all" || name === "operator") throw new Error(`pattern name cannot be "${name}"`);
  if (!Array.isArray(raw.roles) || raw.roles.length < 1 || raw.roles.length > MAX_ROLES) throw new Error(`pattern needs 1-${MAX_ROLES} roles`);
  const roles = raw.roles.map((role) => {
    if (!role || typeof role !== "object") throw new Error("role must be an object");
    const id = String(role.id ?? "");
    if (!ROLE_ID.test(id) || id === DONE) throw new Error(`invalid role id "${id}"`);
    const responsibility = typeof role.responsibility === "string" ? role.responsibility.trim() : "";
    if (!responsibility || responsibility.length > RESPONSIBILITY_MAX) throw new Error(`role "${id}" needs a responsibility of 1-${RESPONSIBILITY_MAX} characters`);
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
  return { name, roles, handoffs };
}

/** Checks every role's harness and model against the allowlists (lib/models.mjs output). */
export async function validatePatternModels(pattern, cfg, env = process.env, models) {
  for (const role of pattern.roles) {
    await validateMember(role.model ? `${role.harness}:${role.model}` : role.harness, cfg, env, models);
  }
  return pattern;
}

/** Merged map: built-in, then global, then project; legacy teams fill names no pattern uses. */
export function listPatterns(cfg, env = process.env) {
  const out = {};
  for (const [name, pattern] of Object.entries(BUILT_IN_PATTERNS)) out[name] = { ...pattern, source: "built-in" };
  for (const [name, pattern] of Object.entries(readGlobalPatterns(env))) out[name] = { ...pattern, source: "global" };
  for (const [name, pattern] of Object.entries(projectPatterns(env, cfg.project))) out[name] = { ...pattern, source: "project" };
  for (const [name, members] of Object.entries(listTeams(cfg, env))) {
    if (!out[name]) out[name] = { ...legacyPattern(name, members), source: "team" };
  }
  return out;
}

export function getPattern(cfg, name, env = process.env) {
  const pattern = listPatterns(cfg, env)[name];
  if (!pattern) throw new Error(`unknown pattern "${name}"`);
  return pattern;
}

/** Saves a pattern to the project's projects.json entry. */
export async function createPattern(cfg, raw, env = process.env, models) {
  const pattern = validatePattern(raw);
  if (listTeams(cfg, env)[pattern.name]) throw new Error(`"${pattern.name}" is a team name; pick another`);
  await validatePatternModels(pattern, cfg, env, models);
  const projects = readProjectsFile(env);
  const entry = projects.find((item) => item?.project === cfg.project);
  if (!entry) throw new Error("Project is not registered in projects.json");
  const patterns = { ...projectPatterns(env, cfg.project), [pattern.name]: pattern };
  writeProjectsFile(env, projects.map((item) => (item?.project === cfg.project ? { ...item, patterns } : item)));
  return pattern;
}

/** Deletes a project pattern; global and built-in patterns stay. */
export function deletePattern(cfg, name, env = process.env) {
  const pattern = getPattern(cfg, name, env);
  if (pattern.source !== "project") throw new Error(`pattern "${name}" is ${pattern.source}; remove it from its file`);
  const projects = readProjectsFile(env);
  const local = { ...projectPatterns(env, cfg.project) };
  delete local[name];
  writeProjectsFile(env, projects.map((item) => (item?.project === cfg.project ? { ...item, patterns: local } : item)));
  return { deleted: name };
}

/** Routes a handoff's required flag into the run's completion rule. */
export function requiredHandoffs(pattern) {
  return pattern.handoffs.filter((handoff) => handoff.required);
}
