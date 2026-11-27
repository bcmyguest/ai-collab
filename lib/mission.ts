/**
 * The PM mission file: MISSION.md at the project root, in git, owned and edited by the PM, and read at every tick.
 * The shape is an H1 title, the mission prose, then "## Goals" (a checkbox list) and "## Rules" (a bullet list).
 * A missing file reads as null; an invalid file throws with its line. Writes go through a temp file and a rename.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { harnessOfCommand } from "./schedule-session.ts";
import { projectRoot } from "./start.mjs";
import { withLock } from "./state.ts";

export const MISSION_FILE = "MISSION.md";
export const MISSION_VERSION = 1;
// The whole file is appended to a tick's prompt, so it stays small: a mission, its goals and its rules.
export const MISSION_MAX_BYTES = 16 * 1024;
export const TITLE_MAX = 200;
export const LINE_MAX = 300;
export const GOALS_MAX = 40;
export const RULES_MAX = 40;

const TITLE = /^#\s+(.+?)\s*$/;
const SECTION = /^##\s+(.+?)\s*$/;
const GOAL = /^-\s+\[([ xX])\]\s+(.+?)\s*$/;
const RULE = /^-\s+(.+?)\s*$/;
// Control characters would put escape codes into an agent's prompt.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export interface MissionDoc {
  v: number;
  title: string;
  mission: string;
  goals: Array<{ text: string; done: boolean }>;
  rules: string[];
}

type MissionChange = (doc: MissionDoc) => MissionDoc;

/** The mission file's path for a project: MISSION.md at the registered root. Throws for an unregistered project. */
export function missionPath(project: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(projectRoot(project, env), MISSION_FILE);
}

function missionError(at: number | undefined, message: string): Error {
  return new Error(at ? `mission: line ${at}: ${message}` : `mission: ${message}`);
}

function checkText(text: string, at: number | undefined, what: string): void {
  if (!text.trim()) throw missionError(at, `${what} is empty`);
  if (text.length > LINE_MAX) throw missionError(at, `${what} is over ${LINE_MAX} characters`);
  if (CONTROL.test(text)) throw missionError(at, `${what} has a control character`);
}

/** Checks a parsed mission and returns it; throws on the first problem. */
export function validateMission(doc: unknown): MissionDoc {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw missionError(0, "expected an object");
  const obj = doc as Record<string, unknown>;
  checkText(typeof obj.title === "string" ? obj.title : "", 0, "title");
  if ((obj.title as string).length > TITLE_MAX) throw missionError(0, `title is over ${TITLE_MAX} characters`);
  if (typeof obj.mission !== "string" || !(obj.mission).trim()) throw missionError(0, "the mission prose is empty");
  // Sections must exist and be well formed; either may be empty, and the tick points that out.
  if (!Array.isArray(obj.goals)) throw missionError(0, "goals must be a list");
  if ((obj.goals as unknown[]).length > GOALS_MAX) throw missionError(0, `at most ${GOALS_MAX} goals`);
  for (const goal of obj.goals as Array<Record<string, unknown>>) {
    if (!goal || typeof goal !== "object" || typeof goal.text !== "string" || typeof goal.done !== "boolean") throw missionError(0, "a goal is {text, done}");
    checkText(goal.text, 0, "a goal");
  }
  if (!Array.isArray(obj.rules)) throw missionError(0, "rules must be a list");
  if ((obj.rules as unknown[]).length > RULES_MAX) throw missionError(0, `at most ${RULES_MAX} rules`);
  for (const rule of obj.rules as unknown[]) {
    if (typeof rule !== "string") throw missionError(0, "a rule is text");
    checkText(rule, 0, "a rule");
  }
  return { v: MISSION_VERSION, title: obj.title as string, mission: obj.mission, goals: (obj.goals as Array<Record<string, unknown>>).map(({ text, done }) => ({ text: text as string, done: done as boolean })), rules: [...(obj.rules as string[])] };
}

/**
 * MISSION.md as {v, title, mission, goals: [{text, done}], rules}. The mission prose runs from the title to
 * "## Goals"; a blank line there separates paragraphs and runs of them collapse to one.
 */
export function parseMission(text: string): MissionDoc {
  if (typeof text !== "string") throw missionError(0, "expected text");
  if (text.includes("\r")) throw missionError(0, "use LF line endings, not CRLF");
  if (Buffer.byteLength(text) > MISSION_MAX_BYTES) throw missionError(0, `the file is over ${MISSION_MAX_BYTES / 1024} KB`);
  let title = "";
  const prose: string[] = [];
  const goals: Array<{ text: string; done: boolean }> = [];
  const rules: string[] = [];
  const seen = new Set<string>();
  let section = "mission";
  let paragraph = false;
  text.split("\n").forEach((raw, index) => {
    const at = index + 1;
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      if (title && section === "mission" && prose.length) paragraph = true;
      return;
    }
    if (!title) {
      const match = TITLE.exec(line);
      if (!match) throw missionError(at, "the first line is \"# <title>\"");
      checkText(match[1], at, "title");
      title = match[1];
      return;
    }
    const heading = SECTION.exec(line);
    if (heading) {
      const name = heading[1].toLowerCase();
      if (name === "goals" || name === "rules") {
        if (seen.has(name)) throw missionError(at, `"## ${heading[1]}" appears twice`);
        if (name === "goals" && seen.has("rules")) throw missionError(at, "\"## Goals\" comes before \"## Rules\"");
        seen.add(name);
        section = name;
        paragraph = false;
        return;
      }
      throw missionError(at, `unknown section "## ${heading[1]}"; the file has "## Goals" and "## Rules"`);
    }
    if (line.startsWith("#")) throw missionError(at, "the only headings are the title, \"## Goals\" and \"## Rules\"");
    if (section === "goals") {
      const match = GOAL.exec(line);
      if (!match) throw missionError(at, "a goal is \"- [ ] text\" or \"- [x] text\"");
      checkText(match[2], at, "a goal");
      goals.push({ text: match[2], done: match[1] !== " " });
      return;
    }
    if (section === "rules") {
      const match = RULE.exec(line);
      if (!match) throw missionError(at, "a rule is \"- text\"");
      checkText(match[1], at, "a rule");
      rules.push(match[1]);
      return;
    }
    checkText(line, at, "the mission line");
    if (paragraph && prose.length) prose.push("");
    paragraph = false;
    prose.push(line);
  });
  if (!title) throw missionError(0, "the file is empty; it starts with \"# <title>\"");
  for (const name of ["goals", "rules"]) if (!seen.has(name)) throw missionError(0, `add a "## ${name[0].toUpperCase()}${name.slice(1)}" section`);
  return validateMission({ title, mission: prose.join("\n"), goals, rules });
}

/** The canonical MISSION.md text: one trailing newline, no trailing spaces, goals then rules. */
export function renderMission(doc: MissionDoc): string {
  validateMission(doc);
  return [
    `# ${doc.title}`,
    "",
    ...doc.mission.split("\n"),
    "",
    "## Goals",
    "",
    ...doc.goals.map((goal) => `- [${goal.done ? "x" : " "}] ${goal.text}`),
    "",
    "## Rules",
    "",
    ...doc.rules.map((rule) => `- ${rule}`),
    "",
  ].join("\n");
}

/** The mission file parsed, or null when it does not exist. Throws with the path when it is invalid. */
export function readMission(file: string): MissionDoc | null {
  if (!existsSync(file)) return null;
  try {
    return parseMission(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`);
  }
}

/** Validates, then writes through a temp file and rename so a reader never sees half a mission. */
export function writeMission(file: string, doc: MissionDoc): MissionDoc {
  validateMission(doc);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, renderMission(doc));
  renameSync(tmp, file);
  return doc;
}

/** Reads, changes and writes the project's mission file under its lock; `change` gets the document and returns it. */
export async function editMission(project: string, change: MissionChange, { env = process.env }: { env?: NodeJS.ProcessEnv } = {}): Promise<MissionDoc> {
  const file = missionPath(project, env);
  const result = await withLock<MissionDoc>(file, async () => {
    const doc = readMission(file);
    if (!doc) throw new Error(`${file}: no mission file; write one first`);
    const next = validateMission(change(doc));
    writeMission(file, next);
    return next;
  });
  if (!result.locked) throw new Error("the mission file is busy; retry");
  return result.value;
}

/**
 * The command with the mission appended to its last argument, so a scheduled agent reads the current file every
 * tick instead of the operator copying it into the command. Only a harness command is touched: a plain script's
 * argv has its own meaning. A missing or invalid file leaves the command alone.
 */
export function withMission(command: string[], { project = "", env = process.env, log = () => {}, file = "" }: { project?: string; env?: NodeJS.ProcessEnv; log?: (msg: string) => void; file?: string } = {}): string[] {
  if (!project || !harnessOfCommand(command)) return command;
  // `file` is the PM workspace copy. Without it the registered project root is the file.
  let doc: MissionDoc | null;
  let missionFile = file;
  try {
    missionFile = file || missionPath(project, env);
    doc = readMission(missionFile);
  } catch (error) {
    log(`mission: ${(error as Error).message}; this tick runs without it`);
    return command;
  }
  if (!doc) {
    log(file
      ? `mission: no ${MISSION_FILE} at ${missionFile}; this tick runs without it`
      : `mission: no ${MISSION_FILE} for project ${project}; this tick runs without it`);
    return command;
  }
  // An empty section is valid but worth pointing out: the tick is the only reader.
  const gaps = [!doc.goals.length && "no goals yet", !doc.rules.length && "no rules yet"].filter(Boolean) as string[];
  const block = [
    `Mission file ${MISSION_FILE}, owned and edited by the PM; keep it current.`,
    ...(file ? [`Edit ${missionFile}. The host checkout is not this workspace.`] : []),
    ...(gaps.length ? [`(${gaps.join(", ")})`] : []),
    "",
    renderMission(doc),
  ].join("\n");
  const last = command.length - 1;
  const prompt = command[last].trim() ? `${command[last]}\n\n${block}` : block;
  return [...command.slice(0, last), prompt];
}
