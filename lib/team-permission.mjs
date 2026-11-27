/**
 * /team-permission: asks the operator on a phone card (Apply or Cancel) and writes the team's team.dot permission
 * attribute only on Apply. The answer is awaited in the background; the chat gets the pending state at once.
 */
import { askQuestion } from "./questions.ts";
import { getPattern, saveTeamText, teamTextOf } from "./patterns.mjs";
import { parseDot, serializeDot } from "./catalog/dot.ts";

/**
 * Starts the confirmation for one team. Returns {status, detail, done}: status "failed" when the team cannot take the
 * attribute, else "pending"; done settles once the answer is handled, so tests and callers can await the write.
 */
export function requestTeamPermission(cfg, name, mode, {
  env = process.env,
  ask = askQuestion,
  pattern = (team) => getPattern(cfg, team, env),
  save = (team, text) => saveTeamText(cfg, team, text, env),
} = {}) {
  let entry;
  try {
    entry = pattern(name);
  } catch (error) {
    return { status: "failed", detail: error.message };
  }
  if (!entry.file) return { status: "failed", detail: `"${name}" is not a team.dot team; only those take a permission attribute.` };
  const question = `Set permission ${mode} on team "${name}"? Apply rewrites its team.dot for later runs.`;
  const done = Promise.resolve()
    .then(() => ask(cfg, question, { choices: ["Apply", "Cancel"], seconds: 600 }))
    .then(async (answer) => {
      if (answer?.answer !== "Apply") return "cancelled";
      const team = parseDot(teamTextOf(entry));
      await save(name, serializeDot({ ...team, permission: mode }));
      return "applied";
    })
    .catch(() => "failed");
  return { status: "pending", detail: `Asked the operator to confirm ${mode} on "${name}".`, done };
}
