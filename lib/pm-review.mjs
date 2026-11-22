/**
 * The run review: the last thing a scheduled harness tick is told, so every run ends with a short review of
 * itself and the lessons that outlive it land in openmem (a fact about the setup) and MISSION.md (a rule the
 * next run follows). Pure text, appended to the prompt like the mission file; a plain script is left alone.
 */
import { RULES_MAX } from "./mission.mjs";
import { harnessOfCommand } from "./schedule-session.mjs";

// The review is the operator's summary of a run, not a report: three lines at most.
export const REVIEW_MAX_LINES = 3;
export const REVIEW_HEADING = "Run review, before you finish";

/**
 * The review instructions appended to every scheduled harness tick. With a project, the openmem bank is named,
 * because the plugin resolves no bank from inside the prompt.
 */
export function reviewBlock({ project = "" } = {}) {
  const bank = project ? `coding-agent::${project}` : "";
  return [
    `${REVIEW_HEADING}:`,
    `- End this run with a short review, in at most ${REVIEW_MAX_LINES} lines: what worked, what did not, and what you would do differently. Post it as the last line of your final post so the operator reads it in the phone chat (\`send_to_all\`; from a shell, \`ai-collab send all "<review>" --progress\`).`,
    `- Keep what you learned before you stop, and say where it went in the review. A fact about this setup goes to openmem with memory_add${bank ? `, bank "${bank}"` : ""}. A standing rule the next run must follow becomes a line in MISSION.md (\`ai-collab mission add-rule "<lesson>"\`; write the file first if the project has none). Work this run left open becomes a task.`,
    `- Do not record a lesson twice. At ${RULES_MAX} rules, merge or drop one rather than add another; a rule the file no longer needs is not worth keeping.`,
  ].join("\n");
}

/** The command with the review appended to its last argument (the prompt, for a harness); a plain script is unchanged. */
export function withReview(command, { project = "" } = {}) {
  if (!harnessOfCommand(command)) return command;
  const block = reviewBlock({ project });
  const last = command.length - 1;
  const prompt = command[last].trim() ? `${command[last]}\n\n${block}` : block;
  return [...command.slice(0, last), prompt];
}
