/** Pattern shape: validation, the team.dot round trip, and legacy rosters read as patterns. No file access. */
import { isValidName } from "../config.ts";
import { START_HARNESSES, modelShape } from "../start.mjs";
import { parseHarnessModel } from "../harness.ts";
import { DOT_PROMPT_MAX, DotError, type DotTeam, type DotTeamInput } from "./dot.ts";
import type { Handoff, Pattern, Role } from "./records.ts";

/** JSON from disk or a request: each field is checked where it is read. */
type Loose = Record<string, unknown>;

export const DONE = "done";
// Same shape as NODE_ID in dot.ts.
const ROLE_ID = /^[a-z][a-z0-9_-]{0,23}$/;
const MAX_ROLES = 8;
const RESPONSIBILITY_MAX = DOT_PROMPT_MAX;
const EVENT_MAX = 60;
const CAP_MAX = 10;
const DESCRIPTION_MAX = 200;

/** Names a pattern may not take: the operator and broadcast names, DONE, harnesses, and this project's peers. */
export function reservedNames(cfg: { peers: string[] }): string[] {
  return ["all", "operator", DONE, ...START_HARNESSES, ...cfg.peers];
}

/** Throws with the node's line when a node has no prompt; validatePattern's own message carries no line. */
export function checkNodePrompts(team: DotTeam): void {
  for (const node of team.nodes) {
    if (!node.prompt) throw new DotError(`role "${node.id}" needs a prompt`, node.line ?? null);
  }
}

/** A parsed team in the shape validatePattern takes: a node's prompt is its role's responsibility. */
export function patternFromTeam(team: DotTeam) {
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
      const parsed = parseHarnessModel(node.agent);
      if (!parsed) throw new Error(`node "${node.id}" has an invalid agent "${node.agent}"`);
      return { id: node.id, responsibility: node.prompt ?? "", harness: parsed.harness, ...(parsed.model ? { model: parsed.model } : {}) };
    }),
    handoffs: team.edges.map((edge) => ({
      from: edge.from, to: edge.to, on: edge.on, required: edge.required, ...(edge.cap !== undefined ? { cap: edge.cap } : {}),
    })),
  };
}

/** Re-attaches the DOT-only fields validatePattern drops (count, skill, fallback, code_mode, kind, max_visits, landing); defaults stay out of the shape. */
export function withExtras(checked: Pattern, team: DotTeam): Pattern {
  const roles: Role[] = checked.roles.map((role, index) => {
    const node = team.nodes[index];
    return {
      ...role,
      ...(node.count > 1 ? { count: node.count } : {}),
      ...(node.skill ? { skill: node.skill } : {}),
      ...(node.fallback ? { fallback: node.fallback } : {}),
      ...(typeof node.codeMode === "boolean" ? { codeMode: node.codeMode } : {}),
    };
  });
  const handoffs: Handoff[] = checked.handoffs.map((handoff, index) => (team.edges[index].kind === "pair" ? handoff : { ...handoff, kind: team.edges[index].kind }));
  return { ...checked, roles, handoffs, ...(team.maxVisits ? { maxVisits: team.maxVisits } : {}), ...(team.permission ? { permission: team.permission } : {}), ...(team.landing ? { landing: team.landing } : {}) };
}

/** A validated pattern as the input of a team.dot file. */
export function teamFromPattern(pattern: Pattern): DotTeamInput {
  return {
    name: pattern.name,
    description: pattern.description ?? "",
    maxVisits: pattern.maxVisits ?? null,
    ...(pattern.landing ? { landing: pattern.landing } : {}),
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

/** A team as a pattern: one role per member, no handoffs. A bad member marks the entry invalid instead of throwing. */
export function legacyPattern(name: string, members: unknown[]): Pattern {
  const parsed = members.map((member) => parseHarnessModel(String(member)));
  const badIndex = parsed.indexOf(null);
  if (badIndex >= 0) return { name, legacy: true, invalid: `team member "${members[badIndex]}" is not a harness or harness:model`, roles: [], handoffs: [] };
  const roles = parsed.map((item, index) => {
    const parsedItem = item ?? { harness: "", model: "" };
    return { id: `${parsedItem.harness}-${index + 1}`, responsibility: "", harness: parsedItem.harness, ...(parsedItem.model ? { model: parsedItem.model } : {}) };
  });
  return { name, legacy: true, roles, handoffs: [] };
}

/** Throws on the first structural problem; checks shape only (models are checked by validatePatternModels). */
export function validatePattern(raw: unknown, reserved: string[] = []): Pattern {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("pattern must be an object");
  const input = raw as Loose;
  const name = input.name;
  if (typeof name !== "string" || !isValidName(name)) throw new Error("pattern name must be 1-24 chars of a-z, 0-9 and single hyphens");
  if (reserved.includes(name)) throw new Error(`pattern name cannot be "${name}"; it is reserved`);
  if (!Array.isArray(input.roles) || input.roles.length < 1 || input.roles.length > MAX_ROLES) throw new Error(`pattern needs 1-${MAX_ROLES} roles`);
  const roles: Role[] = input.roles.map((role: Loose) => {
    if (!role || typeof role !== "object") throw new Error("role must be an object");
    const id = String(role.id ?? "");
    if (!ROLE_ID.test(id) || id === DONE) throw new Error(`invalid role id "${id}"`);
    const responsibility = typeof role.responsibility === "string" ? role.responsibility.trim() : "";
    if (!responsibility || responsibility.length > RESPONSIBILITY_MAX) throw new Error(`role "${id}" needs a prompt of 1-${RESPONSIBILITY_MAX} characters`);
    const harness = role.harness;
    if (typeof harness !== "string" || !(START_HARNESSES as readonly string[]).includes(harness)) throw new Error(`role "${id}" harness must be one of ${START_HARNESSES.join(", ")}`);
    const out: Role = { id, responsibility, harness };
    if (role.model !== undefined && role.model !== "") {
      if (!modelShape(harness, String(role.model))) throw new Error(`role "${id}" has an invalid model`);
      out.model = String(role.model);
    }
    return out;
  });
  const ids = new Set(roles.map((role) => role.id));
  if (ids.size !== roles.length) throw new Error("duplicate role id");
  if (!Array.isArray(input.handoffs) || !input.handoffs.length) throw new Error("pattern needs at least one handoff");
  const seen = new Set<string>();
  const handoffs: Handoff[] = input.handoffs.map((handoff: Loose) => {
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
    const required = handoff.required;
    if (typeof required !== "boolean") throw new Error(`handoff "${from}" -> "${to}" needs required true or false`);
    const out: Handoff = { from, to, on, required };
    if (handoff.cap !== undefined) {
      const cap = handoff.cap;
      if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1 || cap > CAP_MAX || to === DONE) throw new Error(`handoff "${on}" cap must be an integer 1-${CAP_MAX} on a role-to-role handoff`);
      out.cap = cap;
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
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (description.length > DESCRIPTION_MAX) throw new Error(`pattern description must be at most ${DESCRIPTION_MAX} characters`);
  return { name, ...(description ? { description } : {}), roles, handoffs };
}

/** Required handoffs: the run finishes only after each has fired. */
export function requiredHandoffs(pattern: Pattern): Handoff[] {
  return pattern.handoffs.filter((handoff) => handoff.required);
}
