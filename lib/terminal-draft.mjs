import { execFile } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { promisify } from "node:util";
import { isRunning } from "./process.mjs";

const exec = promisify(execFile);
const PROMPT = { claude: /^( *❯ +)/u, codex: /^( *› +)/u };

export function paneHasDraft(harness, tty, output) {
  const [metadata, ...rows] = output.split("\n");
  const [paneTty, mode, x, y] = metadata.split(" ");
  if (paneTty !== tty || mode !== "0" || !/^\d+$/.test(x) || !/^\d+$/.test(y)) return false;
  const line = rows[Number(y)] ?? "";
  const prefix = PROMPT[harness]?.exec(line)?.[0];
  // An empty composer can display placeholder text, with its cursor at the start of the input.
  return Boolean(prefix && Number(x) > prefix.length && line.slice(prefix.length).trim());
}

/** Best-effort local signal. Pane contents stay in memory and only the boolean leaves this function. */
export async function terminalHasDraft(session, { env = process.env } = {}) {
  if (!session?.online || !Object.hasOwn(PROMPT, session.harness)) return false;
  const { pid, pidStart: start, harness } = session;
  if (!isRunning({ pid, start })) return false;
  try {
    const tty = readlinkSync(`/proc/${pid}/fd/0`);
    if (!/^\/dev\/pts\/\d+$/.test(tty)) return false;
    const vars = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    const pane = vars.find(value => /^TMUX_PANE=%\d+$/.test(value))?.slice(10);
    const socket = vars.find(value => value.startsWith("TMUX="))?.slice(5).replace(/,\d+,\d+$/, "");
    if (!pane || !socket?.startsWith("/")) return false;
    const { stdout } = await exec("tmux", ["-N", "-S", socket,
      "display-message", "-p", "-t", pane, "#{pane_tty} #{pane_in_mode} #{cursor_x} #{cursor_y}", ";",
      "capture-pane", "-p", "-t", pane], { env, timeout: 750, maxBuffer: 256 * 1024 });
    return isRunning({ pid, start }) && paneHasDraft(harness, tty, stdout);
  } catch {
    return false;
  }
}
