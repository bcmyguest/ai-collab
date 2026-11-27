import { readFileSync, readlinkSync } from "node:fs";
import { basename } from "node:path";

const MAX_DEPTH = 8;
// names: basenames of argv[0] and of the executable, which `exec -a` cannot change; script: argv[1] for a `node cli.js` start.
const MATCHERS = {
  claude: ({ names, script }) => names.some(n => n === "claude" || n === "claude.exe") || script.includes("/@anthropic-ai/claude-code/"),
  codex: ({ names, script }) => names.includes("codex") || script.includes("/@openai/codex/"),
  cursor: ({ argv }) => argv.some(arg => arg.includes("/cursor-agent/")),
  // The OpenCode server process that runs the plugin; its argv[0] is "opencode" (verified on 2.2.5).
  opencode: ({ names }) => names.includes("opencode"),
};

function stat(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return { ppid: Number(fields[1]), start: fields[19] };
  } catch {
    return null;
  }
}

function argv(pid) {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); } catch { return []; }
}

function exe(pid) {
  try { return readlinkSync(`/proc/${pid}/exe`); } catch { return ""; }
}

/** Nearest ancestor that is the harness process, as {pid, start}; start is /proc stat field 22 so PID reuse is detectable. */
export function harnessProcess(harness, from = process.ppid) {
  const matches = MATCHERS[harness];
  if (!matches) return null;
  for (let pid = from, depth = 0; pid > 1 && depth < MAX_DEPTH; depth++) {
    const info = stat(pid);
    if (!info) return null;
    const args = argv(pid);
    // headless: a print-mode run (`claude -p`) that exits after one prompt and is never idle.
    if (matches({ argv: args, names: [basename(args[0] || ""), basename(exe(pid))], script: args[1] || "" })) return { pid, start: info.start, headless: args.includes("-p") || args.includes("--print") };
    pid = info.ppid;
  }
  return null;
}

/** The /proc start tick of a process, or null when it is not running. */
export function processStart(pid) {
  return stat(pid)?.start ?? null;
}

export function isRunning(proc) {
  return Boolean(proc && Number.isInteger(proc.pid) && stat(proc.pid)?.start === proc.start);
}
