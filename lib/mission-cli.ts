/** `ai-collab mission ...`: read and edit MISSION.md, the PM's mission file in git, read at every scheduled tick. */
import { MISSION_FILE, editMission, missionPath, readMission, renderMission } from "./mission.ts";
import type { Cfg } from "./messaging.ts";

type Writer = { write: (chunk: string) => void };

// oxlint-disable-next-line quality/no-known-value-widening -- looked up by the runtime subcommand
const USAGE: Record<string, string> = {
  show: "usage: mission show",
  check: "usage: mission check",
  "add-goal": 'usage: mission add-goal "<text>"',
  "add-rule": 'usage: mission add-rule "<text>"',
  "done-goal": "usage: mission done-goal <n>",
  "open-goal": "usage: mission open-goal <n>",
  "remove-goal": "usage: mission remove-goal <n>",
  "remove-rule": "usage: mission remove-rule <n>",
};

// The 0-based index of a 1-based position in a list, as the argv names it; NaN for anything else.
function position(arg: string, length: number): number {
  const n = Number(arg);
  return Number.isInteger(n) && n >= 1 && n <= length ? n - 1 : NaN;
}

const HELP_FLAGS = ["--help", "-h"];
const helpText = () => ["usage: ai-collab mission <command>", ...Object.values(USAGE)].join("\n");

export async function mission([sub = "show", ...rest]: string[], { env, cfg, out, err }: { env: NodeJS.ProcessEnv; cfg: Cfg; out: Writer; err: Writer }): Promise<number> {
  const fail = (key: string): number => { err.write(`ai-collab: ${USAGE[key] ?? helpText()}\n`); return 1; };
  // `mission --help` and `mission <command> --help` print usage instead of adding "--help" to a goal.
  if (sub === "help" || HELP_FLAGS.includes(sub)) { out.write(`${helpText()}\n`); return 0; }
  if (rest.some((a) => HELP_FLAGS.includes(a))) {
    if (!(sub in USAGE)) { err.write(`ai-collab: mission: unknown command "${sub}"\n${helpText()}\n`); return 1; }
    out.write(`ai-collab: ${USAGE[sub]}\n`);
    return 0;
  }
  if (!cfg.project) { err.write("ai-collab: mission: AI_COLLAB_PROJECT is not set and no project matches this folder\n"); return 2; }
  const file = missionPath(cfg.project, env);
  try {
    if (sub === "show" || sub === "check") {
      if (rest.length) return fail(sub);
      const doc = readMission(file);
      if (sub === "check") {
        out.write(doc ? `${file}: ok (${doc.goals.length} goals, ${doc.rules.length} rules)\n` : `no ${MISSION_FILE} at ${file}\n`);
        return 0;
      }
      if (!doc) { out.write(`no ${MISSION_FILE} at ${file}\n`); return 0; }
      out.write(`${JSON.stringify(doc, null, 2)}\n`);
      return 0;
    }
    if (sub === "add-goal" || sub === "add-rule") {
      const text = rest.join(" ").trim();
      if (!text) return fail(sub);
      const key = sub === "add-goal" ? "goals" : "rules";
      const doc = await editMission(cfg.project, (current) => ({
        ...current,
        [key]: [...current[key], key === "goals" ? { text, done: false } : text],
      }), { env });
      out.write(renderMission(doc));
      return 0;
    }
    if (sub === "done-goal" || sub === "open-goal") {
      const [arg, ...extra] = rest;
      if (!arg || extra.length) return fail(sub);
      const done = sub === "done-goal";
      const doc = await editMission(cfg.project, (current) => {
        const at = position(arg, current.goals.length);
        if (Number.isNaN(at)) throw new Error(`there is no goal ${arg}; the file has ${current.goals.length}`);
        return { ...current, goals: current.goals.map((goal, i) => (i === at ? { ...goal, done } : goal)) };
      }, { env });
      out.write(renderMission(doc));
      return 0;
    }
    if (sub === "remove-goal" || sub === "remove-rule") {
      const [arg, ...extra] = rest;
      if (!arg || extra.length) return fail(sub);
      const key = sub === "remove-goal" ? "goals" : "rules";
      const doc = await editMission(cfg.project, (current) => {
        const at = position(arg, current[key].length);
        if (Number.isNaN(at)) throw new Error(`there is no ${key === "goals" ? "goal" : "rule"} ${arg}; the file has ${current[key].length}`);
        return { ...current, [key]: current[key].filter((_, i) => i !== at) };
      }, { env });
      out.write(renderMission(doc));
      return 0;
    }
  } catch (error) {
    err.write(`ai-collab: mission ${sub}: ${(error as Error).message}\n`);
    return 1;
  }
  return fail(sub);
}
