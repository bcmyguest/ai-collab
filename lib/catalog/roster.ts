/** Team operations that also read patterns: create a team and start one. Patterns import teams, never the reverse. */
import { isValidName } from "../config.mjs";
import { checkPrompt, startSession } from "../start.mjs";
import { parseHarnessModel } from "../harness.ts";
import { entryTeams, updateProject } from "./projects.ts";
import { allPatternNames, getPattern } from "./patterns.ts";
import { listTeams, recordTeamSession, validateMember, validateMembers, type Models } from "./teams.ts";
import type { CatalogConfig } from "./records.ts";

const UNKNOWN_PATTERN = "unknown pattern ";
const RESERVED_TEAM_NAMES = ["all", "operator"];

type StartFn = (cfg: CatalogConfig, opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
type RunResult = { status: string; session?: string; detail?: string; id?: string };
type StartRunFn = (cfg: CatalogConfig, name: string, task: string, env: NodeJS.ProcessEnv, opts: { start: StartFn; models?: Models }) => Promise<RunResult>;

/** The pattern a role name belongs to when `member` names one of its roles, else null. Legacy rosters return null. */
function patternWithRole(cfg: CatalogConfig, name: string, member: string, env: NodeJS.ProcessEnv) {
  let pattern;
  try {
    pattern = getPattern(cfg, name, env);
  } catch (error) {
    if (String((error as Error).message).startsWith(UNKNOWN_PATTERN)) return null;
    throw error;
  }
  if (pattern.legacy || !pattern.roles.some((role) => role.id === member)) return null;
  return pattern;
}

/** Saves a team in the project's projects.json entry; pattern names and invalid members are refused. */
export async function createTeam(cfg: CatalogConfig, name: string, members: string[], env: NodeJS.ProcessEnv = process.env, models?: Models, { edit = false }: { edit?: boolean } = {}): Promise<{ name: string; members: string[] }> {
  if (!isValidName(name)) throw new Error("team name must be 1-24 chars of a-z, 0-9 and single hyphens");
  if (RESERVED_TEAM_NAMES.includes(name)) throw new Error(`team name cannot be "${name}"`);
  if (allPatternNames(cfg, env).includes(name)) throw new Error(`"${name}" is a pattern name; pick another`);
  const roster = await validateMembers(members, cfg, env, models);
  return updateProject(env, cfg.project, (entry) => {
    const teams = { ...entryTeams(entry) };
    if (edit && (!Object.hasOwn(teams, name) || !Array.isArray(teams[name]) || !teams[name].length)) {
      throw new Error(`"${name}" is not a project team`);
    }
    teams[name] = roster;
    return { entry: { ...entry, teams }, result: { name, members: roster } };
  });
}

/** Starts a team member, or a pattern run when `member` is a role of a pattern named `name`. */
export async function teamStart(cfg: CatalogConfig, name: string, member: string, task: string, env: NodeJS.ProcessEnv = process.env, { start = startSession as unknown as StartFn, models }: { start?: StartFn; models?: Models } = {}): Promise<Record<string, unknown>> {
  if (patternWithRole(cfg, name, member, env)) {
    const { startRun } = await import("../pattern-runs.mjs") as unknown as { startRun: StartRunFn };
    const result = await startRun(cfg, name, task, env, { start, models });
    return { team: name, member, status: result.status, session: result.session || "", detail: result.detail || "", ...(result.id ? { id: result.id } : {}) };
  }
  const teams = listTeams(cfg, env);
  if (!teams[name]) throw new Error(`unknown team "${name}"`);
  if (!teams[name].includes(member)) throw new Error(`"${member}" is not on team "${name}"`);
  await validateMember(member, cfg, env, models);
  const checked = checkPrompt(task);
  if (checked.error) throw new Error(checked.error);
  const parsed = parseHarnessModel(member);
  if (!parsed) throw new Error(`"${member}" is not a harness or harness:model`);
  const result = await start(cfg, { harness: parsed.harness, prompt: checked.text, system: true, env, place: "folder", ...(parsed.model ? { model: parsed.model } : {}) });
  if (typeof result.session === "string") await recordTeamSession(cfg, name, member, result.session);
  return { team: name, member, ...result };
}
