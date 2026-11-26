/** Teams: named member lists from teams.json (global) and projects.json (per project), with member checks and team sessions. */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../config.mjs";
import { listModels } from "../models.mjs";
import { listSessions } from "../sessions.mjs";
import { formatHarnessModel, parseHarnessModel } from "../harness.ts";
import { readJson, withLock, writeJson } from "../store.ts";
import { entryTeams, findProject, plainMap, updateProjects } from "./projects.ts";
import type { CatalogConfig, ProjectEntry } from "./records.ts";

export type Models = Record<string, string[]>;
type TeamSession = Record<string, string>;
type MemberStatus = { member: string; address: string; online: boolean };

function globalTeamsFile(env: NodeJS.ProcessEnv): string {
  return join(configDir(env), "teams.json");
}

function teamStateFile(cfg: CatalogConfig, name: string): string {
  return join(cfg.stateDir, cfg.project, "teams", `${name}.json`);
}

export function readGlobalTeams(env: NodeJS.ProcessEnv = process.env): Record<string, string[]> {
  return plainMap<string[]>(readJson<unknown>(globalTeamsFile(env)));
}

export function writeGlobalTeams(env: NodeJS.ProcessEnv, teams: Record<string, string[]>): void {
  writeJson(globalTeamsFile(env), teams, { indent: 2 });
}

/** Merged team map for a project; project teams override global names. */
export function listTeams(cfg: CatalogConfig, env: NodeJS.ProcessEnv = process.env) {
  const global = readGlobalTeams(env);
  const project = entryTeams(findProject(env, cfg.project));
  const names = new Set([...Object.keys(global), ...Object.keys(project)]);
  const out: Record<string, string[]> = {};
  for (const name of names) {
    const members = project[name] ?? global[name];
    if (Array.isArray(members) && members.length) out[name] = members.map(String);
  }
  return out;
}

/** The harness or harness:model text a member string normalizes to, or null when it is neither. */
export function parseMember(raw: unknown): string | null {
  const parsed = parseHarnessModel(String(raw).trim());
  return parsed ? formatHarnessModel(parsed) : null;
}

/** Checks one member against the project's peers and the model list; returns the normalized member. */
export async function validateMember(member: string, cfg: CatalogConfig, env: NodeJS.ProcessEnv = process.env, models?: Models): Promise<string> {
  const normalized = parseMember(member);
  if (!normalized) throw new Error(`invalid member "${member}"`);
  const split = normalized.indexOf(":");
  const harness = split < 0 ? normalized : normalized.slice(0, split);
  const model = split < 0 ? undefined : normalized.slice(split + 1);
  if (cfg.peers.length && !cfg.peers.includes(harness)) throw new Error(`harness "${harness}" is not in AI_COLLAB_PEERS`);
  if (model) {
    const lists: Models = models ?? await listModels(cfg.stateDir, env, { peers: cfg.peers });
    if (!lists[harness]?.includes(model)) throw new Error(`unknown model "${model}" for ${harness}`);
  }
  return normalized;
}

/** Checks every member and rejects a duplicate; returns the normalized members in order. */
export async function validateMembers(members: string[], cfg: CatalogConfig, env: NodeJS.ProcessEnv = process.env, models?: Models): Promise<string[]> {
  const out: string[] = [];
  for (const member of members) out.push(await validateMember(member, cfg, env, models));
  if (new Set(out).size !== out.length) throw new Error("duplicate members");
  return out;
}

function readTeamSessions(cfg: CatalogConfig, name: string): TeamSession {
  return plainMap<string>(readJson<unknown>(teamStateFile(cfg, name)));
}

/** Records the session address a member started with, under the team's state lock. */
export async function recordTeamSession(cfg: CatalogConfig, name: string, member: string, address: string): Promise<void> {
  const file = teamStateFile(cfg, name);
  mkdirSync(join(cfg.stateDir, cfg.project, "teams"), { recursive: true, mode: 0o700 });
  const prev = readTeamSessions(cfg, name);
  await withLock(file, async () => {
    writeJson(file, { ...prev, [member]: address });
  });
}

/** Each member of a team with the session it started and whether that session is online. */
export function teamStatus(cfg: CatalogConfig, name: string, env: NodeJS.ProcessEnv = process.env): MemberStatus[] {
  const teams = listTeams(cfg, env);
  if (!teams[name]) throw new Error(`unknown team "${name}"`);
  const sessions = readTeamSessions(cfg, name);
  const online = new Set<string>(listSessions(cfg).filter((s) => s.online).map((s) => s.id));
  return teams[name].map((member) => {
    const address = typeof sessions[member] === "string" ? sessions[member] : "";
    return { member, address, online: address ? online.has(address) : false };
  });
}

/** Removes a project-level team; a global team stays in teams.json and throws. */
export function deleteTeam(cfg: CatalogConfig, name: string, env: NodeJS.ProcessEnv = process.env): { deleted: string } {
  return updateProjects(env, (projects) => {
    const teams = listTeams(cfg, env);
    if (!teams[name]) throw new Error(`unknown team "${name}"`);
    const entry = projects.find((item) => item?.project === cfg.project);
    if (!entry?.teams?.[name]) throw new Error(`team "${name}" is global; remove it from teams.json`);
    const local = { ...entryTeams(entry) };
    delete local[name];
    const next = projects.map((item) => (item?.project === cfg.project ? { ...item, teams: local } : item));
    return { projects: next, result: { deleted: name } };
  });
}

/** Task text after an @team tag in a post. */
export function teamTask(body: string, team: string): string {
  const match = new RegExp(`(?:^|[^\\w#-])@${team}\\s+([\\s\\S]*)`).exec(String(body));
  return match?.[1]?.trim() || String(body).trim();
}
