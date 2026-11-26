/**
 * Team author: the operator describes a team in plain language; a writing agent answers with one team.dot;
 * this module turns the chat into that agent's brief, pulls the DOT out of its answer, and saves it only
 * after the existing parser and validator accept it.
 *
 * It never parses DOT itself: every check goes through lib/patterns.mjs `checkTeamText`, and every write goes
 * through lib/patterns.mjs `saveTeamText` (project) or lib/team-files.mjs (global), so a name cannot leave
 * the project or global teams directories.
 */
import { execFile } from "node:child_process";
import { isValidName } from "./config.mjs";
import { parseDot } from "./dot.mjs";
import { checkTeamText, listPatterns, saveTeamText, validatePatternModels } from "./patterns.mjs";
import { childEnv, cursorBinary, findExecutable, modelShape, PROMPT_MAX_CHARS } from "./start.mjs";
import { listTeams } from "./teams.mjs";
import { globalTeamsDir, isRegularFile, saveTeamFile, teamFilePath } from "./team-files.mjs";
import { argv, FALLBACK_MODEL, formatHarnessModel, HARNESSES, isHarness, parseHarnessModel } from "./harness.ts";

export { HARNESSES };
export const AUTHOR_SCOPES = ["project", "global"];
/** One message or role prompt the brief carries; longer text is cut so the brief stays one start prompt. */
export const AUTHOR_TEXT_MAX = 1200;
/** The brief is one start prompt (lib/sessions/launch.ts checkPrompt), so it has the same 4000-character cap. */
export const AUTHOR_PROMPT_MAX = PROMPT_MAX_CHARS;
/** Chat turns carried into the brief, oldest first. */
export const AUTHOR_TURNS_MAX = 12;
/** The order a fallback writer is taken in; the house default comes first. */
export const AUTHOR_PREFERENCE = ["cursor", "claude", "codex", "opencode"];

const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

// The team.dot rules a writing agent needs, in the order it fills the file in.
const CONTRACT = `- Name the digraph for the team: digraph "NAME" { ... }. It must match the team name exactly.
- One node per role:  <id> [agent="HARNESS[:MODEL]", prompt="..."];
- Role id: 1-24 chars of a-z, 0-9 and "-", starting with a letter; "done" is not an id. 1-8 roles.
- prompt: the role's responsibility in one or two sentences, 1-1000 chars. Required on every role.
- agent harness: claude, codex, cursor or opencode; add ":model" only when the operator names one.
- Extra node attributes, when useful: count=1..8 (instances), skill="name", fallback="harness[:model]".
- One edge per handoff:  from -> to [on="event", kind="pair", required=true];
- kind is pair (default), broadcast or fan-in; required=true means the run cannot finish without it.
- cap=1..10 limits a role-to-role handoff's repeats. A pair edge needs the same count on both roles.
- "done" only receives an edge; never declare it. At least one edge must reach done.
- Every role must be reachable from the first role, which is the entry role.
- graph [description="one sentence", max_visits=1..50] is optional.
- No node/edge defaults, no subgraphs, no variables. Quote ids that contain "-".
- Prefer few roles: one per distinct responsibility, and one handoff event per real transition.`;

/** The models a vague request falls back to; the first is the house default. */
const HOUSE_MODELS = `cursor:${FALLBACK_MODEL}, claude:claude-haiku-5-5, then plain codex or opencode`;

const scopeLine = (scope) => (scope === "global"
  ? "Scope: global — the file is saved in the config directory and every project can use it."
  : "Scope: project — the file is saved in this project's .ai-collab/teams folder.");

function turnLines(turns) {
  const lines = [];
  for (const turn of turns) {
    const text = oneLine(turn?.text).slice(0, AUTHOR_TEXT_MAX);
    if (text) lines.push(`${turn?.from === "agent" ? "Your last answer" : "Operator"}: ${text}`);
  }
  return lines;
}

/**
 * The brief for the writing agent: its one job, the team.dot contract, the name and scope, the team being
 * edited (if any), the chat so far, and the operator's request. Always fits one start prompt.
 */
export function buildAuthorPrompt({ request, name = "", scope = "project", current = "", turns = [], peers = [] } = {}) {
  const named = isValidName(name);
  const teamName = named ? name : "team-name";
  const useScope = AUTHOR_SCOPES.includes(scope) ? scope : "project";
  const harnesses = (Array.isArray(peers) ? peers : []).filter((peer) => HARNESSES.includes(peer));
  let useRequest = oneLine(request).slice(0, AUTHOR_TEXT_MAX);
  let useCurrent = String(current ?? "").trim();
  let useTurns = (Array.isArray(turns) ? turns : []).filter((turn) => oneLine(turn?.text)).slice(-AUTHOR_TURNS_MAX);

  const compose = () => {
    const lines = [
      "You author teams for ai-collab. Turn the operator's request into one team.dot file.",
      "",
      "Answer with exactly one fenced block and nothing else:",
      "```dot",
      `digraph "${teamName}" {`,
      "  ...",
      "}",
      "```",
      "",
      "The file must pass these checks:",
      CONTRACT,
      "",
      `Team name: ${named ? teamName : "the name the operator confirms"}`,
      scopeLine(useScope),
      harnesses.length ? `This project may run: ${harnesses.join(", ")}.` : "",
      `When the operator names no model, prefer ${HOUSE_MODELS}.`,
    ];
    if (useCurrent) lines.push("", "The team as it is now; change only what the request asks for:", "```dot", useCurrent, "```");
    const history = turnLines(useTurns);
    if (history.length) lines.push("", "Conversation so far, oldest first:", ...history);
    lines.push("", useTurns.length ? "New request from the operator:" : "Operator request:", useRequest || "(the operator has not said yet)");
    return lines.join("\n");
  };

  // An oversized brief keeps its rules and its name, and drops history, then the current team, then request text.
  for (;;) {
    const text = compose();
    if (text.length <= AUTHOR_PROMPT_MAX) return text;
    if (useTurns.length) { useTurns = useTurns.slice(1); continue; }
    if (useCurrent.length > 400) { useCurrent = `${useCurrent.slice(0, 400)}\n...`; continue; }
    if (useRequest.length > 200) { useRequest = `${useRequest.slice(0, 200)}...`; continue; }
    return text.slice(0, AUTHOR_PROMPT_MAX);
  }
}

const FENCE = /```[ \t]*(?:dot|graphviz)?[ \t]*\r?\n([\s\S]*?)```/g;

/** Every block that could hold DOT, in the order the writing agent wrote them: fenced blocks, then a bare digraph. */
function dotBlocks(text) {
  const source = String(text ?? "");
  const blocks = [];
  for (const match of source.matchAll(FENCE)) {
    const body = match[1].trim();
    if (body) blocks.push(body);
  }
  const start = /^\s*digraph\b/m.exec(source);
  const end = source.lastIndexOf("}");
  if (start && end > start.index) blocks.push(source.slice(start.index, end + 1).trim());
  return blocks;
}

/** The first block that parses as team.dot, else the first block as written ("" when the answer has none). */
export function extractDot(reply) {
  const blocks = dotBlocks(String(reply ?? ""));
  for (const block of blocks) {
    try { parseDot(block); return block; } catch { /* next block */ }
  }
  return blocks[0] ?? "";
}

/**
 * The DOT from a writing agent's answer, checked by the same parse and validate a save uses.
 * Returns { ok:true, dot, pattern, warnings, exists } or { ok:false, error, line, dot }.
 * `exists` is the source of the entry already using the name ("" when the name is free).
 * `suggested` is the digraph name the agent wrote, so the UI can propose it when the operator left the name blank.
 */
export function draftTeam(cfg, { name = "", reply = "", env = process.env } = {}) {
  const dot = extractDot(reply);
  if (!dot) return { ok: false, error: "The answer has no DOT block; ask the agent for one ```dot block.", line: null, dot: "", suggested: "", name: "" };
  const suggested = (() => { try { return parseDot(dot).name; } catch { return ""; } })();
  // With no name yet, the digraph name the agent wrote is the proposal the operator confirms.
  const useName = isValidName(name) ? name : suggested;
  const check = checkTeamText(cfg, useName, dot);
  const all = listPatterns(cfg, env);
  const existing = Object.hasOwn(all, useName) ? all[useName] : undefined;
  if (!check.ok) return { ...check, dot, suggested, name: useName };
  return { ...check, dot, suggested, name: useName, exists: existing?.source ?? "" };
}

/**
 * Saves authored DOT as a team file in the project or global teams directory.
 *
 * The text is parsed, validated and model-checked first. An existing entry of the same name is replaced only
 * when `replace` names it (the operator's confirm), a built-in is never shadowed, and a legacy roster name is
 * refused. Project saves go through saveTeamText, so they take the same locks and drop a shadowed JSON pattern.
 */
export async function saveAuthoredTeam(cfg, { name, dot, scope = "project", replace = "", env = process.env, models } = {}) {
  const teamName = String(name ?? "");
  if (!isValidName(teamName)) throw new Error("Team name must be 1-24 chars of a-z, 0-9 and single hyphens");
  if (!AUTHOR_SCOPES.includes(scope)) throw new Error('Scope must be "project" or "global"');
  const confirmed = replace === teamName && Boolean(teamName);

  const check = checkTeamText(cfg, teamName, String(dot ?? ""));
  if (!check.ok) throw Object.assign(new Error(check.error), { line: check.line });
  const text = `${String(dot).trimEnd()}\n`;

  const all = listPatterns(cfg, env);
  const existing = Object.hasOwn(all, teamName) ? all[teamName] : undefined;
  if (existing?.source === "built-in") throw new Error(`"${teamName}" is a built-in pattern; pick another name`);
  if (listTeams(cfg, env)[teamName]) throw new Error(`"${teamName}" is a team name; pick another`);
  // Saving into the other scope would make a second file that silently shadows the first.
  if (existing && scope === "project" && existing.source === "global") {
    throw new Error(`"${teamName}" is a global team; save it with global scope, or pick another name`);
  }
  if (existing && scope === "global" && existing.source === "project") {
    throw new Error(`"${teamName}" is a project team; edit that copy, or pick another name`);
  }
  if (existing && !confirmed) throw new Error(`"${teamName}" already exists; confirm the replacement to save over it`);

  if (scope === "project") {
    // saveTeamText takes the projects.json lock, writes the file and drops a shadowed JSON pattern.
    return await saveTeamText(cfg, teamName, text, env, models, { create: !confirmed });
  }

  const file = teamFilePath(globalTeamsDir(env), teamName);
  if (isRegularFile(file) && !confirmed) throw new Error(`"${teamName}" already exists; confirm the replacement to save over it`);
  await validatePatternModels(check.pattern, cfg, env, models);
  await saveTeamFile(file, text);
  return { ...check.pattern, source: "global", file };
}

/** Harness and model for the writing agent: AI_COLLAB_TEAM_AUTHOR_MODEL, else the house default. */
export function authorModel(env = process.env) {
  const raw = String(env.AI_COLLAB_TEAM_AUTHOR_MODEL || formatHarnessModel({ harness: "cursor", model: FALLBACK_MODEL })).trim();
  const [harness] = raw.split(":");
  if (!isHarness(harness)) return { harness: "cursor", model: FALLBACK_MODEL };
  return parseHarnessModel(raw) ?? { harness, model: "" };
}

/**
 * The writer to use: authorModel, unless the project cannot run that harness and another is installed, in which case
 * that harness writes with no model (a model name belongs to the harness it was chosen for).
 */
export function authorHarness(env = process.env, startable = []) {
  const chosen = authorModel(env);
  if (!startable.length || startable.includes(chosen.harness)) return chosen;
  const fallback = AUTHOR_PREFERENCE.find((harness) => startable.includes(harness));
  return fallback ? { harness: fallback, model: "" } : chosen;
}

/** The argv for one non-interactive writing-agent turn; the brief is one element, so no shell quoting applies. */
export function authorCommand(harness, prompt, model = "") {
  return argv(harness, "author", { prompt, model });
}

/**
 * One writing-agent turn: the brief goes to the harness as a single argument and its stdout comes back.
 * Resolves { status:"answered", reply } or { status:"failed", detail }; an injected `run` stands in for the whole
 * exec step (it is called with the harness name, so a test needs no binary on PATH), and with no `run` the binary
 * must be on PATH or the turn fails as "not installed". A non-zero exit keeps the harness's own stderr (a usage
 * limit is printed there and stdout is empty), so the operator sees why it stopped.
 */
export async function askAuthor(prompt, { harness, model, env = process.env, timeoutMs = 180_000, run } = {}) {
  const command = authorCommand(harness, String(prompt ?? ""), model ?? "");
  if (!command) return { status: "failed", detail: `unknown harness "${harness}"` };
  const vars = childEnv(env);
  const [binary, args] = command;
  const name = harness === "cursor" && !run ? cursorBinary(vars.PATH) : binary;
  const exec = run ?? ((file, argv, options) => new Promise((resolve) => {
    execFile(file, argv, { ...options, timeout: timeoutMs, maxBuffer: 1 << 20, shell: false }, (error, stdout, stderr) => resolve({
      code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
      stdout: String(stdout || ""),
      stderr: String(stderr || ""),
    }));
  }));
  const file = run ? name : findExecutable(name, vars.PATH);
  if (!file) return { status: "failed", detail: `${name} is not installed` };
  const result = await exec(file, args, { env: vars, cwd: env.HOME || process.cwd() });
  const reply = String(result?.stdout ?? "").trim();
  const errorText = String(result?.stderr ?? "").trim();
  if (result?.code !== 0) {
    const why = (reply || errorText).replace(/\s+/g, " ").slice(0, 300);
    return { status: "failed", detail: `${name} exited ${result?.code}${why ? `: ${why}` : ""}`, reply };
  }
  if (!reply) return { status: "failed", detail: `${name} answered nothing` };
  return { status: "answered", reply, harness, file };
}

/**
 * One authoring turn end to end: build the brief, ask a writing agent, and check the DOT it returned.
 * The operator sees the draft; nothing is saved until saveAuthoredTeam with the confirmed name.
 */
export async function authorTeam(cfg, { request, name = "", scope = "project", current = "", turns = [], peers = [], startable = [], env = process.env, ...agent } = {}) {
  const prompt = buildAuthorPrompt({ request, name, scope, current, turns, peers });
  const chosen = authorHarness(env, startable);
  const answer = await askAuthor(prompt, { harness: agent.harness ?? chosen.harness, model: agent.model ?? chosen.model, env, ...(agent.run ? { run: agent.run } : {}) });
  if (answer.status !== "answered") return { ...answer, prompt };
  return { ...answer, prompt, ...draftTeam(cfg, { name, reply: answer.reply, env }) };
}
