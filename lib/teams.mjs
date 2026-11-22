import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, isValidName, listProjects } from "./config.mjs";
import { START_HARNESSES, checkPrompt, modelShape, startSession } from "./start.mjs";
import { listModels } from "./models.mjs";
import { listSessions } from "./sessions.mjs";
import { withLock, writeState } from "./state.mjs";
import { allPatternNames } from "./patterns.mjs";

const MEMBER = /^([a-z0-9-]+)(?::(.+))?$/;

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}

export function globalTeamsFile(env = process.env) {
  return join(configDir(env), "teams.json");
}

export function readGlobalTeams(env = process.env) {
  const value = readJson(globalTeamsFile(env));
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function writeGlobalTeams(env, teams) {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(globalTeamsFile(env), `${JSON.stringify(teams, null, 2)}\n`, { mode: 0o600 });
}

function projectsFile(env) {
  return join(configDir(env), "projects.json");
}

export function readProjectsFile(env) {
  const value = readJson(projectsFile(env));
  return Array.isArray(value) ? value : [];
}

/** Writes projects.json through a temp file and rename, so a reader never sees a partial file. */
export function writeProjectsFile(env, projects) {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = projectsFile(env);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(projects, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Marks a registered project closed or open; its repo, worktrees and ntfy history stay. */
export function setProjectClosed(env, project, closed) {
  const projects = readProjectsFile(env);
  if (!projects.some((entry) => entry?.project === project)) throw Object.assign(new Error("Project is not registered in projects.json"), { status: 404 });
  writeProjectsFile(env, projects.map((entry) => (entry?.project === project ? { ...entry, closed } : entry)));
}

/** Removes a project's projects.json entry; its repo, worktrees and ntfy history stay. */
export function removeProject(env, project) {
  const projects = readProjectsFile(env);
  if (!projects.some((entry) => entry?.project === project)) throw Object.assign(new Error("Project is not registered in projects.json"), { status: 404 });
  writeProjectsFile(env, projects.filter((entry) => entry?.project !== project));
}

/** Names of the registered projects marked closed. */
export function closedProjectNames(env) {
  return readProjectsFile(env).filter((entry) => entry?.closed === true).map((entry) => entry.project);
}

function projectEntry(env, project) {
  return readProjectsFile(env).find((entry) => entry?.project === project);
}

/** Merged team map for a project; project teams override global names. */
export function listTeams(cfg, env = process.env) {
  const global = readGlobalTeams(env);
  const local = projectEntry(env, cfg.project)?.teams;
  const project = local && typeof local === "object" && !Array.isArray(local) ? local : {};
  const names = new Set([...Object.keys(global), ...Object.keys(project)]);
  const out = {};
  for (const name of names) {
    const members = project[name] ?? global[name];
    if (Array.isArray(members) && members.length) out[name] = members.map(String);
  }
  return out;
}

export function parseMember(raw) {
  const match = MEMBER.exec(String(raw).trim());
  if (!match || !START_HARNESSES.includes(match[1])) return null;
  const model = match[2];
  if (model !== undefined && !modelShape(match[1], model)) return null;
  return model ? `${match[1]}:${model}` : match[1];
}

export async function validateMember(member, cfg, env = process.env, models) {
  const normalized = parseMember(member);
  if (!normalized) throw new Error(`invalid member "${member}"`);
  const split = normalized.indexOf(":");
  const harness = split < 0 ? normalized : normalized.slice(0, split);
  const model = split < 0 ? undefined : normalized.slice(split + 1);
  if (cfg.peers.length && !cfg.peers.includes(harness)) throw new Error(`harness "${harness}" is not in AI_COLLAB_PEERS`);
  if (model) {
    const lists = models ?? await listModels(cfg.stateDir, env, { peers: cfg.peers });
    if (!lists[harness]?.includes(model)) throw new Error(`unknown model "${model}" for ${harness}`);
  }
  return normalized;
}

export async function validateMembers(members, cfg, env = process.env, models) {
  const out = [];
  for (const member of members) out.push(await validateMember(member, cfg, env, models));
  if (new Set(out).size !== out.length) throw new Error("duplicate members");
  return out;
}

function teamStateFile(cfg, name) {
  return join(cfg.stateDir, cfg.project, "teams", `${name}.json`);
}

export function readTeamSessions(cfg, name) {
  const value = readJson(teamStateFile(cfg, name));
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function recordTeamSession(cfg, name, member, address) {
  const file = teamStateFile(cfg, name);
  mkdirSync(join(cfg.stateDir, cfg.project, "teams"), { recursive: true, mode: 0o700 });
  const prev = readTeamSessions(cfg, name);
  await withLock(file, () => writeState(file, { ...prev, [member]: address }));
}

export function teamStatus(cfg, name, env = process.env) {
  const teams = listTeams(cfg, env);
  if (!teams[name]) throw new Error(`unknown team "${name}"`);
  const sessions = readTeamSessions(cfg, name);
  const online = new Map(listSessions(cfg).filter((s) => s.online).map((s) => [s.id, true]));
  return teams[name].map((member) => {
    const address = typeof sessions[member] === "string" ? sessions[member] : "";
    return { member, address, online: address ? online.has(address) : false };
  });
}

export async function teamStart(cfg, name, member, task, env = process.env, { start = startSession, models } = {}) {
  const teams = listTeams(cfg, env);
  if (!teams[name]) throw new Error(`unknown team "${name}"`);
  if (!teams[name].includes(member)) throw new Error(`"${member}" is not on team "${name}"`);
  await validateMember(member, cfg, env, models);
  const checked = checkPrompt(task);
  if (checked.error) throw new Error(checked.error);
  const split = member.indexOf(":");
  const harness = split < 0 ? member : member.slice(0, split);
  const model = split < 0 ? undefined : member.slice(split + 1);
  const result = await start(cfg, { harness, prompt: checked.text, env, place: "folder", ...(model ? { model } : {}) });
  if (typeof result.session === "string") await recordTeamSession(cfg, name, member, result.session);
  return { team: name, member, ...result };
}

export async function createTeam(cfg, name, members, env = process.env, models) {
  if (!isValidName(name)) throw new Error("team name must be 1-24 chars of a-z, 0-9 and single hyphens");
  if (name === "all" || name === "operator") throw new Error(`team name cannot be "${name}"`);
  if (allPatternNames(cfg, env).includes(name)) throw new Error(`"${name}" is a pattern name; pick another`);
  const roster = await validateMembers(members, cfg, env, models);
  const projects = readProjectsFile(env);
  const entry = projects.find((item) => item?.project === cfg.project);
  if (!entry) throw new Error("Project is not registered in projects.json");
  const teams = entry.teams && typeof entry.teams === "object" && !Array.isArray(entry.teams) ? { ...entry.teams } : {};
  teams[name] = roster;
  const next = projects.map((item) => (item?.project === cfg.project ? { ...item, teams } : item));
  writeProjectsFile(env, next);
  return { name, members: roster };
}

export function deleteTeam(cfg, name, env = process.env) {
  const teams = listTeams(cfg, env);
  if (!teams[name]) throw new Error(`unknown team "${name}"`);
  const projects = readProjectsFile(env);
  const entry = projects.find((item) => item?.project === cfg.project);
  if (!entry?.teams?.[name]) throw new Error(`team "${name}" is global; remove it from teams.json`);
  const local = { ...entry.teams };
  delete local[name];
  const next = projects.map((item) => (item?.project === cfg.project ? { ...item, teams: local } : item));
  writeProjectsFile(env, next);
  return { deleted: name };
}

/** Task text after an @team tag in a post. */
export function teamTask(body, team) {
  const match = new RegExp(`(?:^|[^\\w#-])@${team}\\s+([\\s\\S]*)`).exec(String(body));
  return match?.[1]?.trim() || String(body).trim();
}