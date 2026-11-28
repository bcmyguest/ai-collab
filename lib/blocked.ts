// What a Claude session does when auto mode or a hook blocks an action, and the channel note an auto-mode denial posts.
import type { Cfg } from "./messaging.ts";

const SUMMARY_MAX = 300;

/** SessionStart context for Claude: a block is a reason to reroute or ask, never a reason to stop. */
export function blockedHint(cfg: Cfg, host: string): string {
  if (host !== "claude" || !cfg.session) return "";
  const s = JSON.stringify(cfg.session);
  return "[ai-collab] When auto mode or a hook blocks an action you need (an edit to an existing test or golden, a merge, a push), do not end your turn with \"I can't\". "
    + "Take another route at once: write the change as a patch under $CLAUDE_JOB_DIR/tmp/ (else /tmp/dbg/tmp/) and build one command that applies, commits and pushes it. "
    + `Then ask the operator with the ai-collab ask_question tool (session=${s}, important=true), naming the blocked action, why it is needed and that command, and wait for the answer. `
    + "Approvals from the phone do not unblock auto mode, so the operator runs the command; continue once it lands.";
}

/** The channel note for one auto-mode denial: the tool, a short summary of its input, and the classifier's reason. */
export function deniedNote(input: { tool_name?: unknown; tool_input?: unknown; reason?: unknown }, address: string): string {
  const tool = typeof input.tool_name === "string" ? input.tool_name : "a tool";
  const raw = input.tool_input as Record<string, unknown> | undefined;
  const detail = typeof raw?.command === "string" ? raw.command : typeof raw?.file_path === "string" ? raw.file_path : "";
  const summary = detail.length > SUMMARY_MAX ? `${detail.slice(0, SUMMARY_MAX)}…` : detail;
  const reason = typeof input.reason === "string" && input.reason ? ` (${input.reason})` : "";
  return `auto mode blocked ${address}: ${tool}${summary ? ` ${summary}` : ""}${reason}`;
}
