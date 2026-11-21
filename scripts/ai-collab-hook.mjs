#!/usr/bin/env node
/**
 * Agent hook. Reads one JSON object on stdin and writes exactly one JSON object on stdout.
 * Events: SessionStart (status start + current AFK mode + inbox), UserPromptSubmit / PostToolUse (inbox, throttled),
 * Stop (deliver waiting messages, AFK wait, important-question hold; see lib/stop.mjs), SessionEnd (status stop).
 * Every event also publishes activity (prompts, tool calls and results, assistant text; never thinking) to the
 * project's activity topic unless AI_COLLAB_ACTIVITY=off; that publish runs alongside delivery under a 1.5 s cap.
 * --activity marks a registration that only publishes activity and returns the neutral output.
 * A prompt the operator typed records operatorPromptAt for this session; AFK mode changes only when the operator sets it.
 * --host opencode takes Claude-shaped input from the OpenCode plugin (lib/opencode-plugin.mjs) and answers in Claude's shapes.
 * PermissionRequest (Claude, Codex, OpenCode) and Cursor beforeShellExecution / beforeMCPExecution ask the operator's phone in AFK
 * mode on or quiet (lib/approvals.mjs); no answer means no decision, so the harness shows its own prompt.
 * In mode off a Claude or Codex prompt becomes a view-only card; PostToolUse(Failure), Stop, StopFailure, UserPromptSubmit
 * or SessionEnd of that session closes it.
 * Any failure prints {} and exits 0: the session continues unchanged. Transcripts are never read.
 * Every message handed to the agent gets a read receipt, published in the background like activity.
 */
import path from "node:path";
import { loadConfig, ownEnv, sessionLabel } from "../lib/config.mjs";
import { claimInbox, publishStatus } from "../lib/inbox.mjs";
import { childHint, exportParent, greetParent, parentLine } from "../lib/family.mjs";
import { formatInbox, hookOutput, identityLine, stopOutput } from "../lib/format.mjs";
import { currentMode, operatorPrompt, takeModeNote } from "../lib/mode.mjs";
import { decideStop } from "../lib/stop.mjs";
import { recordSession } from "../lib/sessions.mjs";
import { sessionName } from "../lib/names.mjs";
import { harnessProcess } from "../lib/process.mjs";
import { contextTokens, reportContext } from "../lib/usage.mjs";
import { activityEvents, publishActivity } from "../lib/activity.mjs";
import { sendReceipts, settleReceipts } from "../lib/receipts.mjs";
import { closeTerminalCards, decideApproval } from "../lib/approvals.mjs";
import { standsDown } from "../lib/owned.mjs";

const HOSTS = new Set(["claude", "codex", "cursor", "opencode"]);
const EVENTS = new Map([
  ["sessionstart", "SessionStart"],
  ["startup", "SessionStart"],
  ["userpromptsubmit", "UserPromptSubmit"],
  ["beforesubmitprompt", "UserPromptSubmit"],
  ["posttooluse", "PostToolUse"],
  ["stop", "Stop"],
  ["sessionend", "SessionEnd"],
  ["precompact", "PreCompact"],
  ["permissionrequest", "PermissionRequest"],
  ["beforeshellexecution", "PermissionRequest"],
  ["beforemcpexecution", "PermissionRequest"],
]);
// Events that refresh the recorded session name; Codex names a thread after its first prompt.
const NAMED_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "Stop"]);
// Cursor permission hooks fall through to Cursor's own prompt with "ask".
const CURSOR_PERMISSION = new Set(["beforeshellexecution", "beforemcpexecution"]);

function hostArg(argv) {
  const i = argv.indexOf("--host");
  const h = i >= 0 ? String(argv[i + 1] || "") : "claude";
  return HOSTS.has(h) ? h : "claude";
}

function readStdin(limitMs = 2000) {
  return new Promise((resolve) => {
    const chunks = [];
    const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString("utf8")), limitMs);
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
  });
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

// Output for an activity-only registration: Cursor's beforeSubmitPrompt must allow the prompt explicitly.
function neutral(host, key) {
  if (host === "cursor" && CURSOR_PERMISSION.has(key)) return { permission: "ask" };
  return host === "cursor" && key === "beforesubmitprompt" ? { continue: true } : {};
}

async function deliver(cfg, host, event, msg, key) {
  if (event === "PermissionRequest") {
    // The harness may kill a waiting hook, for example when the prompt is answered in the terminal; close the request.
    const ctrl = new AbortController();
    for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(name, () => ctrl.abort());
    return decideApproval(cfg, { host, key, input: msg, signal: ctrl.signal });
  }
  // A subagent shares its parent's session id; its messages stay queued for the root session.
  if (typeof msg.agent_id === "string" && msg.agent_id) return neutral(host, key);
  if (["PostToolUse", "Stop", "PreCompact"].includes(event)) {
    await reportContext(cfg, contextTokens(host, msg)).catch(() => {});
  }
  if (event === "PreCompact") return {};
  if (event === "Stop") {
    const decision = await decideStop(cfg, { host, input: msg });
    if (decision.action === "continue") {
      const note = await takeModeNote(cfg);
      return stopOutput(host, [note, decision.text].filter(Boolean).join("\n"));
    }
  }
  if (event === "Stop" || event === "SessionEnd") {
    await publishStatus(cfg, { event: "stop", harness: host }).catch(() => {});
    return {};
  }
  let family = "";
  if (event === "SessionStart") {
    await publishStatus(cfg, { event: "start", harness: host }).catch(() => {});
    await currentMode(cfg).catch(() => {});
    if (host === "claude") exportParent(cfg, process.env.CLAUDE_ENV_FILE);
    await greetParent(cfg, { harness: host, cwd: msg.cwd }).catch(() => {});
    family = [parentLine(cfg), childHint(cfg, host)].filter(Boolean).join("\n");
  }
  const messages = await claimInbox(cfg, { throttle: event !== "SessionStart", limit: 4 });
  sendReceipts(cfg, messages.map((m) => m.id));
  const note = await takeModeNote(cfg, { force: event === "SessionStart" });
  const identity = event === "SessionStart" || messages.length ? identityLine(cfg) : "";
  const text = [note, identity, family, formatInbox(messages, { session: cfg.session })].filter(Boolean).join("\n");
  return hookOutput(host, event, text);
}

async function main() {
  const argv = process.argv.slice(2);
  const host = hostArg(argv);
  const activityOnly = argv.includes("--activity");
  const raw = await readStdin();
  let msg;
  try {
    msg = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return emit({});
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return emit({});
  // Cursor also runs Claude Code plugins' hooks; its own registration (--host cursor) handles the event.
  if (host !== "cursor" && typeof msg.cursor_version === "string") return emit({});
  // Cursor sends workspace_roots instead of cwd and runs ~/.cursor/hooks.json hooks from the home folder.
  const roots = Array.isArray(msg.workspace_roots) ? msg.workspace_roots.filter((r) => typeof r === "string" && path.isAbsolute(r)) : [];
  const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : roots[0] || process.cwd();
  msg.cwd = cwd;
  // A child agent inherits its parent's shell environment; ownEnv keeps it from taking the parent's identity.
  const env = ownEnv(process.env, host);
  const sessionId = [msg.session_id, msg.sessionId, msg.conversation_id, msg.conversationId, env.CURSOR_CONVERSATION_ID]
    .find((id) => typeof id === "string" && id.length > 0);
  const session = sessionLabel(sessionId);
  const key = String(msg.hook_event_name || msg.hookEventName || msg.event_name || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  const cfg = loadConfig(env, { cwd, host, session });
  if (!cfg.enabled) return emit(neutral(host, key));
  // The runner drives an owned session and publishes everything itself (docs/owned-sessions-contract.md).
  if (standsDown(cfg, { host, label: session, env: process.env })) return emit(neutral(host, key));

  // Started first and awaited last, so delivery never waits on it.
  const events = activityEvents(host, key, msg);
  const activity = publishActivity(cfg, host, events).catch(() => 0);
  // A view-only approval card (AFK off) closes once a later event shows the terminal prompt resolved.
  const closing = closeTerminalCards(cfg, { host, key, input: msg }).catch(() => []);
  const event = EVENTS.get(key);
  let output = neutral(host, key);
  // A prompt the operator typed (not a wake run, agent hand-back or ai-collab's own text); recorded, AFK unchanged.
  const typed = (key === "userpromptsubmit" || key === "beforesubmitprompt") && operatorPrompt(msg.prompt);
  // A subagent's hooks carry the parent's session id; its cwd (often a worktree) must not rename the parent.
  const subagent = typeof msg.agent_id === "string" && msg.agent_id !== "";
  if (event || events.length) {
    try {
      if (!subagent) await recordSession(cfg, {
        id: sessionId, cwd, harness: host, event: event || key.slice(0, 32), proc: harnessProcess(host), parent: cfg.parent,
        name: NAMED_EVENTS.has(event) ? sessionName(host, msg, env) : "",
        ...(typed ? { operatorPromptAt: Date.now() } : {}),
      }).catch(() => {});
      if (event && !activityOnly) output = await deliver(cfg, host, event, msg, key);
    } catch {
      output = neutral(host, key);
    }
  }
  emit(output);
  await Promise.all([activity, closing, settleReceipts()]);
}

try {
  await main();
} catch {
  try { emit({}); } catch { /* stdout closed */ }
}
