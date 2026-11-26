/**
 * Parent and child agents: a session exports its address as AI_COLLAB_PARENT to the shell its agent runs commands in
 * (Claude Code: CLAUDE_ENV_FILE at SessionStart), so an agent it starts there (codex exec, claude -p, cursor-agent -p)
 * learns its parent; the child's SessionStart tells the child both addresses and sends the parent one direct message.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { sendMessage } from "./messaging.ts";
import type { Cfg } from "./messaging.ts";
import { claimParentNotice } from "./sessions.mjs";

const address = (cfg: Cfg) => `${cfg.peer}#${cfg.session}`;

/** Appends `export AI_COLLAB_PARENT=<this session>` to Claude's env file once, so later Bash commands carry it. */
export function exportParent(cfg: Cfg, file: unknown): boolean {
  if (!cfg.session || typeof file !== "string" || !isAbsolute(file)) return false;
  const line = `export AI_COLLAB_PARENT=${address(cfg)}`;
  try {
    let current = "";
    try { current = readFileSync(file, "utf8"); } catch { /* new file */ }
    if (current.split("\n").includes(line)) return false;
    appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Sends the parent "started: <child> (<harness>, <folder>)" once per session; the folder name only, never the path. */
export async function greetParent(cfg: Cfg, { harness, cwd }: { harness?: string; cwd?: unknown }): Promise<boolean> {
  if (!cfg.parent || !cfg.session || !(await claimParentNotice(cfg))) return false;
  const folder = typeof cwd === "string" && cwd ? basename(cwd) : "";
  await sendMessage(cfg, cfg.parent, `started: ${address(cfg)} (${[harness, folder].filter(Boolean).join(", ")})`);
  return true;
}

/** How this session starts a child agent that reports back; Claude's shell already carries AI_COLLAB_PARENT. */
export function childHint(cfg: Cfg, host: string): string {
  if (!cfg.session) return "";
  const prefix = host === "claude" ? "" : `AI_COLLAB_PARENT=${address(cfg)} `;
  return `[ai-collab] An agent you start from your shell in this project joins AI Collab and messages you its address: `
    + `${prefix}codex exec "<prompt>", ${prefix}claude -p "<prompt>", or ${prefix}cursor-agent -p "<prompt>". Message it with send_to_peer; list sessions with list_sessions.`;
}

/** Hook context for a child: its own address, its parent's, and how to answer it. */
export function parentLine(cfg: Cfg): string {
  if (!cfg.parent || !cfg.session) return "";
  return `[ai-collab] You were started by the agent ${cfg.parent}; your address is ${address(cfg)}. `
    + `Report to it with the ai-collab send_to_peer tool (to=${JSON.stringify(cfg.parent)}, session=${JSON.stringify(cfg.session)}) `
    + `or AI_COLLAB_PEER=${cfg.peer} AI_COLLAB_SESSION=${cfg.session} ai-collab send ${cfg.parent} "<message>".`;
}
