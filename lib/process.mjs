import { readFileSync } from "node:fs";
import { basename } from "node:path";

const MAX_DEPTH = 8;
const MATCHERS = {
  claude: argv => ["claude", "claude.exe"].includes(basename(argv[0] || "")),
  codex: argv => basename(argv[0] || "") === "codex",
  cursor: argv => argv.some(arg => arg.includes("/cursor-agent/")),
  // The OpenCode server process that runs the plugin; its argv[0] is "opencode" (verified on 2.2.5).
  opencode: argv => basename(argv[0] || "") === "opencode",
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

/** Nearest ancestor that is the harness process, as {pid, start}; start is /proc stat field 22 so PID reuse is detectable. */
export function harnessProcess(harness, from = process.ppid) {
  const matches = MATCHERS[harness];
  if (!matches) return null;
  for (let pid = from, depth = 0; pid > 1 && depth < MAX_DEPTH; depth++) {
    const info = stat(pid);
    if (!info) return null;
    if (matches(argv(pid))) return { pid, start: info.start };
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
