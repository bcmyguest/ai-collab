import { readFileSync, readlinkSync } from "node:fs";
import { basename } from "node:path";

export interface HarnessProcess {
  pid: number;
  start: string;
  headless: boolean;
}

interface ProcessView {
  argv: string[];
  names: string[];
  script: string;
}

const MAX_DEPTH = 8;
// names: basenames of argv[0] and of the executable, which `exec -a` cannot change; script: argv[1] for a `node cli.js` start.
// oxlint-disable-next-line quality/no-known-value-widening -- looked up by a runtime harness name
const MATCHERS: Record<string, (view: ProcessView) => boolean> = {
  claude: ({ names, script }) => names.some(n => n === "claude" || n === "claude.exe") || script.includes("/@anthropic-ai/claude-code/"),
  codex: ({ names, script }) => names.includes("codex") || script.includes("/@openai/codex/"),
  cursor: ({ argv }) => argv.some(arg => arg.includes("/cursor-agent/")),
  // The OpenCode server process that runs the plugin; its argv[0] is "opencode" (verified on 2.2.5).
  opencode: ({ names }) => names.includes("opencode"),
};

function stat(pid: number): { ppid: number; start: string } | null {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return { ppid: Number(fields[1]), start: fields[19] };
  } catch {
    return null;
  }
}

function argv(pid: number): string[] {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); } catch { return []; }
}

function exe(pid: number): string {
  try { return readlinkSync(`/proc/${pid}/exe`); } catch { return ""; }
}

/** Nearest ancestor that is the harness process, as {pid, start}; start is /proc stat field 22 so PID reuse is detectable. */
export function harnessProcess(harness: string, from: number = process.ppid): HarnessProcess | null {
  const matches: ((view: ProcessView) => boolean) | undefined = MATCHERS[harness];
  if (!matches) return null;
  for (let pid = from, depth = 0; pid > 1 && depth < MAX_DEPTH; depth++) {
    const info = stat(pid);
    if (!info) return null;
    const args = argv(pid);
    const binary = basename(exe(pid));
    // A node process also goes by its script's name, as a JS entry started through its bin symlink (`node …/bin/claude`).
    const names = [basename(args[0] || ""), binary, ...(binary.startsWith("node") ? [basename(args[1] || "")] : [])];
    // headless: a print-mode run (`claude -p`) that exits after one prompt and is never idle.
    if (matches({ argv: args, names, script: args[1] || "" })) return { pid, start: info.start, headless: args.includes("-p") || args.includes("--print") };
    pid = info.ppid;
  }
  return null;
}

/** The /proc start tick of a process, or null when it is not running. */
export function processStart(pid: number): string | null {
  return stat(pid)?.start ?? null;
}

export function isRunning(proc: { pid?: unknown; start?: unknown } | null | undefined): boolean {
  return Boolean(proc && Number.isInteger(proc.pid) && stat(proc.pid as number)?.start === proc.start);
}
