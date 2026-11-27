#!/usr/bin/env node
/**
 * Agent hook. Reads one JSON object on stdin and writes exactly one JSON object on stdout.
 * Events: SessionStart (status start + current AFK mode + inbox), UserPromptSubmit / PostToolUse (inbox, throttled),
 * Stop (deliver waiting messages, AFK wait, important-question hold; see lib/stop.mjs), SessionEnd (status stop).
 * Every event also publishes activity (prompts, tool calls and results, assistant text; never thinking) to the
 * project's activity topic unless AI_COLLAB_ACTIVITY=off; that publish runs alongside delivery under a 1.5 s cap.
 * --rewake marks the Claude asyncRewake registration (lib/waiter.ts): it prints no JSON; it exits 2 with the messages on stderr.
 * --activity marks a registration that only publishes activity and returns the neutral output.
 * InstructionsLoaded (Claude) records the instruction file it loaded in the session's context state (lib/usage.mjs).
 * A prompt the operator typed records operatorPromptAt for this session; AFK mode changes only when the operator sets it.
 * --host opencode takes Claude-shaped input from the OpenCode plugin (lib/opencode-plugin.mjs) and answers in Claude's shapes.
 * PermissionRequest (Claude, Codex, OpenCode) and Cursor beforeShellExecution / beforeMCPExecution ask the operator's phone in AFK
 * mode on or quiet (lib/approvals.mjs); no answer means no decision, so the harness shows its own prompt.
 * In mode off a Claude or Codex prompt becomes a view-only card; PostToolUse(Failure), Stop, StopFailure, UserPromptSubmit
 * or SessionEnd of that session closes it.
 * Any failure prints {} and exits 0: the session continues unchanged. Transcripts are never read.
 * --read-gate refuses an agent read of the task store or state dir when readsThroughRunCode is on, with the
 * run_code recipe, and otherwise prints {}. Cursor beforeShellExecution and beforeReadFile use it so a
 * non-matching command is not turned into an approval prompt. A human shell never runs this hook.
 * Cursor events also feed the run's OTLP trace (lib/cursor-trace.mjs); its export waits at most 1.5 s after the output.
 * Every message handed to the agent gets a read receipt, published in the background like activity.
 */
import path from "node:path";
import { loadConfig, ownEnv, sessionLabel } from "../lib/config.mjs";
import { claimInbox, publishStatus } from "../lib/messaging.ts";
import { childHint, exportParent, greetParent, parentLine } from "../lib/family.ts";
import { formatInbox, hookOutput, identityLine, stopOutput } from "../lib/format.mjs";
import { currentMode, operatorPrompt, takeModeNote } from "../lib/mode.mjs";
import { SYSTEM_PROMPT_ENV } from "../lib/machine-prompt.mjs";
import { decideStop } from "../lib/stop.mjs";
import { REQUIRE_RUN_CODE_ENV } from "../lib/code-mode.mjs";
import { readsThroughRunCode } from "../lib/code-run.mjs";
import { storeReadDenial } from "../lib/store-read.mjs";
import { recordSession, sessionName, standsDown } from "../lib/sessions/registry.ts";
import { MANAGED_ENV, MANAGED_START_REFUSED, managedDenial, managedStartAllowed } from "../lib/subagent-guard.ts";
import { harnessProcess, isRunning, processStart } from "../lib/process.mjs";
import { WAITER_MAX_S, runWaiter, takeWaiterSlot } from "../lib/waiter.ts";
import { ON_DEMAND_LOADS, contextUsage, dropOnDemandFiles, readContext, recordInstructions, reportContext } from "../lib/usage.mjs";
import { activityEvents, publishActivity } from "../lib/activity.mjs";
import { compactionFields } from "../lib/compaction.mjs";
import { clearFields } from "../lib/session-events.mjs";
import { sendReceipts, settleReceipts } from "../lib/receipts.mjs";
import { closeTerminalCards, decideApproval, decideQuestion } from "../lib/approvals.mjs";
import { classifyLimit } from "../lib/limits.ts";
import { alertLimit } from "../lib/limit-alert.mjs";
import { hookTrace } from "../lib/cursor-trace.mjs";

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
  ["postcompact", "PostCompact"],
  ["permissionrequest", "PermissionRequest"],
  ["beforeshellexecution", "PermissionRequest"],
  ["beforemcpexecution", "PermissionRequest"],
]);
// Events that refresh the recorded session name; Codex names a thread after its first prompt.
const NAMED_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "Stop"]);
// Cursor permission hooks fall through to Cursor's own prompt with "ask".
const CURSOR_PERMISSION = new Set(["beforeshellexecution", "beforemcpexecution"]);

// A compaction start or clear carries the meter's last reading; a compaction start also counts the on-demand files it drops.
function stampContext(cfg, events) {
  const context = readContext(cfg);
  const tokensBefore = context.tokens ?? undefined;
  const filesDropped = context.files.filter(entry => ON_DEMAND_LOADS.has(entry.load)).length;
  return events.map(event => {
    if (event.clear) return { ...event, clear: clearFields({ tokensBefore }) };
    if (event.compaction?.phase === "started") return { ...event, compaction: compactionFields({ ...event.compaction, tokensBefore, filesDropped }) };
    return event;
  });
}

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
    const usage = contextUsage(host, msg);
    await reportContext(cfg, usage.tokens, { window: usage.window }).catch(() => {});
  }
  if (event === "PreCompact") return {};
  if (event === "Stop") {
    const decision = await decideStop(cfg, { host, input: msg, onHold: () => publishStatus(cfg, { event: "hold", harness: host }) });
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
    family = [parentLine(cfg), childHint(cfg)].filter(Boolean).join("\n");
  }
  const messages = await claimInbox(cfg, { throttle: event !== "SessionStart", limit: 4 });
  sendReceipts(cfg, messages.map((m) => m.id));
  const note = await takeModeNote(cfg, { force: event === "SessionStart" });
  const identity = event === "SessionStart" ? identityLine(cfg) : "";
  const text = [note, identity, family, formatInbox(messages, { session: cfg.session, peer: cfg.peer })].filter(Boolean).join("\n");
  return hookOutput(host, event, text);
}

// Claude asyncRewake registration: waits for a peer message and exits 2 with it, which wakes an idle session.
async function rewake(cfg, host, msg) {
  if (host !== "claude" || !cfg.session || (typeof msg.agent_id === "string" && msg.agent_id)) return;
  const harness = harnessProcess(host);
  // A headless run is never idle, and an exit 2 at UserPromptSubmit blocks its prompt; its own hooks deliver messages.
  if (harness?.headless) return;
  const release = await takeWaiterSlot(cfg);
  const ctrl = new AbortController();
  for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(name, () => ctrl.abort());
  let result = { code: 0 };
  try {
    result = await runWaiter(cfg, {
      maxMs: (Number(process.env.AI_COLLAB_WAITER_MAX_S) || WAITER_MAX_S) * 1000, signal: ctrl.signal,
      alive: () => !harness || isRunning(harness),
    });
  } finally {
    release();
  }
  if (result.code !== 2) process.exit(0);
  process.stderr.write(`${result.text}\n`, () => process.exit(2));
}

let traced = null;

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
  // File reads of the task store and state dir. Checked before config and activity so a missing project still refuses,
  // and so Cursor's shell and read hooks return {} instead of asking. Codex and Claude PreToolUse deny here too.
  const storeRead = storeReadDenial(host, key, msg);
  if (storeRead && readsThroughRunCode(env)) return emit(storeRead);
  // A managed session's native subagent or shell harness start is refused (lib/subagent-guard.ts); before standsDown, so owned Cursor sessions refuse too.
  // Codex PreToolUse runs --activity only, so its shell gate runs on every Codex hook call.
  if (argv.includes("--read-gate") || host === "codex") {
    const denied = managedDenial(host, key, msg, env, { cwd, host, session });
    if (denied) return emit(denied);
  }
  if (argv.includes("--read-gate")) return emit({});
  // Backstop for a shell start the command check misses (bash -c, npx): a managed env without a ticket stops the harness.
  if ((key === "sessionstart" || key === "startup") && !argv.includes("--rewake")
      && !managedStartAllowed(env, { cwd, host, session }, harnessProcess(host) ?? { pid: process.ppid, start: processStart(process.ppid) })) {
    return emit({ continue: false, stopReason: MANAGED_START_REFUSED });
  }
  // Every Cursor run, joined project or not, records its turn for the OTLP trace (lib/cursor-trace.mjs); never awaited before output.
  traced = host === "cursor" ? hookTrace(msg, { env }).catch(() => null) : null;
  const cfg = loadConfig(env, { cwd, host, session });
  if (!cfg.enabled) return emit(neutral(host, key));
  // The runner drives an owned session and publishes everything itself (docs/owned-sessions-contract.md).
  if (standsDown(cfg, { label: session })) return emit(neutral(host, key));
  if (argv.includes("--rewake")) return rewake(cfg, host, msg);

  // Started first and awaited last, so delivery never waits on it.
  const events = key === "precompact" || key === "sessionend" ? stampContext(cfg, activityEvents(host, key, msg)) : activityEvents(host, key, msg);
  if (env[SYSTEM_PROMPT_ENV] === "1") {
    for (const event of events) if (event.type === "prompt") event.system = true;
  }
  const activity = publishActivity(cfg, host, events).catch(() => 0);
  // A finished compaction has dropped the on-demand files, so the next one must not count them again.
  const dropped = key === "postcompact" ? dropOnDemandFiles(cfg).catch(() => false) : Promise.resolve(false);
  // A view-only approval card (AFK off) closes once a later event shows the terminal prompt resolved.
  const closing = closeTerminalCards(cfg, { host, key, input: msg }).catch(() => []);
  // Claude's StopFailure with error rate_limit: a limit card for this session, one per window (lib/limit-alert.mjs).
  const limit = key === "stopfailure" && host === "claude" && !(typeof msg.agent_id === "string" && msg.agent_id) ? classifyLimit("claude", { kind: "stop_failure", ...msg }) : null;
  const limited = limit ? alertLimit(cfg, { harness: "claude", limit, auto: true }).catch(() => ({})) : Promise.resolve({});
  const event = EVENTS.get(key);
  let output = neutral(host, key);
  // A prompt the operator typed (not a wake run, agent hand-back or ai-collab's own text); recorded, AFK unchanged.
  const typed = (key === "userpromptsubmit" || key === "beforesubmitprompt") && operatorPrompt(msg.prompt);
  // A subagent's hooks carry the parent's session id; its cwd (often a worktree) must not rename the parent.
  const subagent = typeof msg.agent_id === "string" && msg.agent_id !== "";
  // The PreToolUse matcher for AskUserQuestion blocks until the phone answers or the terminal dialog takes over.
  if (key === "pretooluse" && msg.tool_name === "AskUserQuestion" && !activityOnly) {
    const ctrl = new AbortController();
    for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(name, () => ctrl.abort());
    return emit(subagent ? {} : await decideQuestion(cfg, { host, input: msg, signal: ctrl.signal }));
  }
  // Claude's InstructionsLoaded: an instruction file entered the context; recorded for the session's context view.
  if (key === "instructionsloaded" && !subagent) await recordInstructions(cfg, msg).catch(() => {});
  if (event || events.length) {
    try {
      if (!subagent) await recordSession(cfg, {
        id: sessionId, cwd, harness: host, event: event || key.slice(0, 32), proc: harnessProcess(host), parent: cfg.parent,
        name: NAMED_EVENTS.has(event) ? sessionName(host, msg, env) : "", model: msg.model,
        requireRunCode: env[REQUIRE_RUN_CODE_ENV] === "1", managed: env[MANAGED_ENV] === "1",
        ...(typed ? { operatorPromptAt: Date.now() } : {}),
      }).catch(() => {});
      if (event && !activityOnly) output = await deliver(cfg, host, event, msg, key);
    } catch {
      output = neutral(host, key);
    }
  }
  emit(output);
  await Promise.all([activity, closing, dropped, limited, settleReceipts()]);
}

try {
  await main();
} catch {
  try { emit({}); } catch { /* stdout closed */ }
}
await traced;
