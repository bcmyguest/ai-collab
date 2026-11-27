// The registered session a scheduled command resumes, so a run can link to that session's timeline.
import { basename, isAbsolute, relative as relativePath, sep } from "node:path";
import { sessionLabel } from "./config.ts";
import { harnessOfBinary } from "./harness.ts";

// The flag that names the session to resume, per harness; Codex takes it as `codex exec resume <id>`.
// oxlint-disable-next-line quality/no-known-value-widening -- looked up by a runtime harness name
const RESUME_FLAGS: Record<string, string[]> = { cursor: ["--resume", "-r"], claude: ["--resume", "-r"], opencode: ["--session", "-s"] };
// A harness session id: a UUID or a thread name; never a path or another flag.
const SESSION_ID = /^[A-Za-z0-9][\w.:@-]{0,255}$/;

// The value of the first of names the args carry, as `--flag value` or `--flag=value`.
function valueAfter(args: unknown[], names: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== "string") continue;
    const joined = names.find((name) => arg.startsWith(name + "="));
    if (joined) return arg.slice(joined.length + 1);
    if (names.includes(arg)) {
      const next = args[i + 1];
      if (typeof next === "string" && !next.startsWith("-")) return next;
    }
  }
  return "";
}

/**
 * The registered project whose folder holds a path (the deepest match), or "" when none does. A schedule's cwd names
 * the project its session publishes under, so its runs link to that project's timeline.
 */
export function projectOfFolder(folder: unknown, projects: Array<{ root?: unknown; project?: unknown } | null | undefined> = []): string {
  if (typeof folder !== "string" || !folder) return "";
  let best = "";
  let bestRoot = "";
  for (const entry of projects) {
    if (typeof entry?.root !== "string" || typeof entry.project !== "string") continue;
    const relative = relativePath(entry.root, folder);
    if (relative === ".." || relative.startsWith(".." + sep) || isAbsolute(relative)) continue;
    if (entry.root.length > bestRoot.length || !best) { best = entry.project; bestRoot = entry.root; }
  }
  return best;
}

/** The harness a command runs (by its binary's name), or "" for a plain script or a wrapper like `npx`. */
export function harnessOfCommand(command: unknown): string {
  return Array.isArray(command) && typeof command[0] === "string" ? harnessOfBinary(basename(command[0])) || "" : "";
}

/**
 * The session a scheduled command resumes, as {harness, session}, or null when the command names none (a plain
 * script, a harness with no resume flag, a wrapper binary). The label is the same hash the session's hooks publish.
 */
export function sessionOfCommand(command: unknown): { harness: string; session: string } | null {
  if (!Array.isArray(command) || !command.length || typeof command[0] !== "string") return null;
  const harness = harnessOfCommand(command);
  if (!harness) return null;
  const arg = harness === "codex" ? valueAfter(command.slice(1), ["resume"]) : valueAfter(command.slice(1), RESUME_FLAGS[harness]);
  if (!SESSION_ID.test(arg || "")) return null;
  const session = sessionLabel(arg);
  return session ? { harness, session } : null;
}
