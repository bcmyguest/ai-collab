// Runner core: one durable "session" workflow per owned session; control calls and bus input become durable messages.
import { isProjectPaused, PROJECT_PAUSED } from "../lib/project-pause.ts";
import { adaptSqlite } from "../lib/workflows.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { EventType } from "@ag-ui/core";
import { DOT_EVENT_MAX } from "../lib/catalog/dot.ts";
import { getPattern } from "../lib/catalog/patterns.ts";
import { activatePatternTargets, applyPatternAdvance, cutPatternEnter, cutPatternEntry, cutPatternLeave, cutPatternRun, launchPatternRun, NOTE_MAX, preparePatternRun, RUN_ID, runStatus, sessionsOfRun } from "../lib/pattern-runs.ts";
import { patternWorkflowId, runIdOfPatternWorkflow, runPatternWorkflow, seedPatternRun } from "../lib/pattern-workflow.ts";
import { statePath } from "../lib/state.ts";
import { SESSION_LABEL, broadcastTopic, inboxTopic, isValidName, parentAddress, receiptsTopic, sessionLabel, startPlaceSetting } from "../lib/config.ts";
import { RESERVE_MS, ATTACHMENT_BUDGET_MS, claimInbox, markDelivered, mentionsAgent, parseEnvelope, releaseOwned, reserveOwned, reservedMessage, sendMessage } from "../lib/messaging.ts";
import { parsePhoneReply, parseQuestionText } from "../lib/questions.ts";
import { replyDecision, APPROVAL_ID } from "../lib/approvals.ts";
import { formatInbox } from "../lib/format.ts";
import { attachmentOf, cacheAttachmentsWithin, localizedAttachment } from "../lib/attachment-cache.ts";
import { streamEvents } from "../lib/messaging.ts";
import { handedOff, handOff } from "../lib/stop.ts";
import { listSessions, recordSession } from "../lib/sessions/registry.ts";
import { claudeConfirmedSince, claudeSnapshot, claudeWindowMs } from "../lib/claude-socket.ts";
import { ackTracker, busyWithPush, direct, holdRunning, PUSHED, pushSession, readDispatchLedger, readySession, writeDispatchLedger } from "../lib/deliver-push.ts";
import { MAX_ATTEMPTS } from "../lib/delivery.ts";
import { sessionIdleState } from "../lib/idle.ts";
import { opencodeRequest } from "../lib/opencode-api.ts";
import { BUILDER_START_TIMEOUT_MS, builderPaths, builderResumePrompt, stoppedBuilder, ownedBuilder, stageOwnedBuilder, claimOwnedBuilder, finishOwnedBuilder, markOwnedBuilderFailed } from "../lib/builder.ts";
import { gitRunner, pickedWorktree } from "../lib/sessions/git-refs.ts";
import { mergeIntoParent, parentBranch } from "../lib/thread-branch.ts";
import { PROMPT_MAX_CHARS, childEnv, checkPrompt, claudePermissionFor, projectRoot, worktreeNames } from "../lib/sessions/launch.ts";
import { findExecutable } from "../lib/sessions/scope.ts";
import { modelShape } from "../lib/harness.ts";
import { parseCodeMode, resolveCodeMode } from "../lib/code-mode.ts";
import { openTasks } from "../lib/tasks.ts";
import { describeFinish, finishMemberBranch, landFinishRequest } from "../lib/land-member.ts";
import { listOwned, nextPermission, ownedFile, readOwned, writeOwned } from "../lib/sessions/registry.ts";
import { modelFields } from "../lib/session-events.ts";
import { isBlockingLimit, limitFromRunError } from "../lib/limits.ts";
import { alertLimit } from "../lib/limit-alert.ts";
import { APPROVAL_REQUESTED, APPROVAL_RESOLVED, ERROR, LIMIT, NOTICE, PERMISSION_MODES, PLACES, approvalTimeoutMs, defaultPermission, eventProblem, OPENSHELL_PERMISSION, permissionSettings, runnerModeOfClaude } from "./contract.ts";
import { sessionOfCommand } from "../lib/schedule-session.ts";
import { ALLOW_HOST_AGENT_ENV } from "../lib/agent-guard.ts";
import { noSubagentEnv } from "../lib/subagent-guard.ts";
import { SPAWN_MAX_CHILDREN, SPAWN_MAX_DEPTH, spawnBriefNote, spawnReport, spawnSelfNote } from "../lib/spawn.ts";
import { harnessSandboxName, sandboxCapRefusal, teamSandboxName } from "../lib/sandbox.ts";
import { DELIVERY, deliveryWorkflow } from "./delivery.ts";
import { publishApproval, publishApprovalEnd, publishEnded, publishEvent, publishReceipts } from "./publish.ts";

// oxlint-disable-next-line typescript/no-explicit-any -- harness protocol frames, session records and runner requests are JSON
type Json = any;
/** createRunner's options; tests inject the clock, git, durable log and logger. */
type RunnerOptions = {
  projects: Json[]; adapters: Map<string, Json>; durable: Json; env?: NodeJS.ProcessEnv; git?: typeof runGit; now?: () => number;
  startGapMs?: number; approvalMs?: number; watch?: boolean; log?: (message: string) => void; scheduleErrors?: Json[];
  scheduleEntries?: Json[]; pumpMs?: number; delivery?: Json; startTimeoutMs?: number;
};

export const START_TIMEOUT_MS = 60_000;
export const START_GAP_MS = 10_000;
export const CLOSE_WAIT_MS = 10_000;
export const MANUAL_RUN_GAP_MS = 10_000;
export const WAKE = "wake";
// How often the runner looks for direct messages to live sessions that have no delivery workflow yet.
export const PUMP_MS = 5000;
// Steps and messages of finished workflows older than 12 h (an operator-run ntfy server's longest cache window) are pruned hourly;
// the workflow row stays as a tombstone.
export const PRUNE_AFTER_MS = 12 * 3_600_000;
const PRUNE_EVERY_MS = 3_600_000;
const CLAIM_LIMIT = 4;
const WAKE_BATCH = 20;
const WAKES_PER_TICK = 2;
// A wake send that certainly did not start a turn and says it is transient (a codex thread still closing) is retried:
// WAKE_SEND_ATTEMPTS tries in all, pausing WAKE_SEND_BACKOFF_MS doubling, capped at WAKE_SEND_BACKOFF_MAX_MS.
export const WAKE_SEND_ATTEMPTS = 3;
export const WAKE_SEND_BACKOFF_MS = 500;
export const WAKE_SEND_BACKOFF_MAX_MS = 4000;
const SEEN_WITHIN_MS = 7 * 24 * 3_600_000;
const CONFIRM_POLL_MS = 500;
const WAKE_TOPIC = "wake";
// Longest pause, in pump ticks, after a tick that met a 429 from the bus URL (only an operator-run ntfy server rate-limits).
const PUMP_BACKOFF_MAX_TICKS = 6;
const STREAM_RETRY_MAX_MS = 30_000;
const TEXT_MAX = 4000;
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:/[\]-]{0,119}$/;
// Harnesses whose adapter runs a child per managed session, so the managed env marks only that session.
// OpenCode and Cursor share one process; their hooks read the owned record instead.
const MANAGED_ENV_HARNESSES = new Set(["claude", "codex"]);
// Spawned children of every harness run in OpenShell with full access, never on the host (docs/spawn-agent-spec.md, answer 6).
const SPAWN_IN_OPENSHELL = new Set(["claude", "codex", "cursor", "opencode"]);
// A worktree add that fails, most often on a name a parallel start just took, retries this many times in all.
const WORKTREE_ATTEMPTS = 4;
// A spawned child cut by a restart gets this turn instead of an "interrupted" report, up to RESTART_RESUMES times in a row.
const RESTART_RESUMES = 3;
const BRANCH_NAME = /^(?!-)[A-Za-z0-9._/-]{1,200}$/;
const RESTART_RESUME_PROMPT = "The runner restarted during your last turn. Check what you already did (git status, files, messages), then finish the task and report as before.";

const fail: (status: Json, message: string) => never = (status, message) => { throw Object.assign(new Error(message), { status }); };
// Approvals off outside OpenShell is an unguarded agent on the host (lib/agent-guard.ts); only the operator's env lifts it.
const hostFullAccess = (mode: Json, place: Json, env: Json) => mode === "full-access" && place !== "openshell" && env[ALLOW_HOST_AGENT_ENV] !== "1"
  ? `full-access runs only in openshell; set ${ALLOW_HOST_AGENT_ENV}=1 on the runner to allow it on the host` : "";

// This process as {pid, start}, the shape lib/process.ts isRunning checks.
function selfProcess() {
  try {
    const text = readFileSync("/proc/self/stat", "utf8");
    return { pid: process.pid, start: text.slice(text.lastIndexOf(")") + 2).split(" ")[19] };
  } catch {
    return null;
  }
}

function runGit(file: Json, args: Json, options: Json) {
  return new Promise((resolve) => execFile(file, args, options, (error) => resolve(error ? (error.code ?? 1) : 0)));
}

// Queued inputs as one run: texts joined, message ids merged.
const merge = (batch: Json) => ({ text: batch.map((i: Json) => i.text).join("\n\n"), messageIds: batch.flatMap((i: Json) => i.messageIds || []) });
// The code-mode setting a record and adapter options carry; omitted when unknown (records from before the setting).
const codeModeField = (codeMode: Json) => (typeof codeMode === "boolean" ? { codeMode } : {});

function patternHandoff(reply: Json) {
  const line = reply?.trimEnd().split("\n").at(-1);
  const prefix = "PATTERN_ADVANCE ";
  if (!line?.startsWith(prefix)) return undefined;
  try {
    const { event, note } = JSON.parse(line.slice(prefix.length));
    if (typeof event === "string" && (note === undefined || typeof note === "string")) return { event, note };
  } catch { /* No valid handoff in this reply. */ }
  return undefined;
}

/** Public view of a session for the control API. */
function view(s: Json) {
  const r = s.record;
  return {
    session: r.address, harness: r.harness, project: r.project, nativeId: r.nativeId, workflowId: r.workflowId, cwd: r.cwd,
    place: r.place, status: r.status, permissionMode: r.permissionMode, ...(r.model ? { model: r.model } : {}), ...codeModeField(r.codeMode), run: r.run,
    ...(r.taskId ? { taskId: r.taskId } : {}), approvals: r.approvals.map(({ id, tool, summary }: Json) => ({ id, tool, summary })), ...(r.cut ? { cut: r.cut } : {}),
  };
}

/** Claim handoff between a session workflow and its waiter. On DBOS, boot's pending() launches and
 * recovers before waiters exist, so a claim that arrives early is kept and delivered to the next take.
 * An early claim whose waiter never comes (it timed out and dropped before the claim landed) expires
 * after the TTL instead of leaking; any set or take prunes the stale entries. */
export function createClaims({ now = Date.now } = {}) {
  const EARLY_TTL_MS = 10 * 60_000;
  const waiters = new Map();
  const early = new Map(); // id → { value, at }: kept until the next take or the TTL
  function prune() {
    const at = now();
    for (const [id, entry] of early) if (at - entry.at >= EARLY_TTL_MS) early.delete(id);
  }
  return {
    take(id: Json) {
      prune();
      if (early.has(id)) return Promise.resolve(early.get(id).value);
      return new Promise((resolve) => waiters.set(id, resolve));
    },
    set(id: Json, value: Json) {
      prune();
      const resolve = waiters.get(id);
      if (resolve) { waiters.delete(id); resolve(value); }
      else early.set(id, { value, at: now() });
    },
    drop(id: Json) { waiters.delete(id); early.delete(id); },
  };
}

/** Creates the runner over project configs, a Map harness → Adapter and a durable log (lib/durable.ts). */
export function createRunner({ projects, adapters, durable: rawDurable, env = process.env, git = runGit, now = Date.now, startGapMs = START_GAP_MS, approvalMs = approvalTimeoutMs(env), watch = true, log = () => {}, scheduleErrors = [], scheduleEntries = [], pumpMs = PUMP_MS, delivery = {}, startTimeoutMs = START_TIMEOUT_MS }: RunnerOptions) {
  // Tests hand createRunner a raw sqlite log; the runner itself passes an openWorkflows engine. One async surface either way.
  const durable = rawDurable.isAsync === true ? rawDurable : adaptSqlite(rawDurable);
  const configs = new Map<string, Json>(projects.map((cfg: Json) => [cfg.project, cfg]));
  const manualAt = new Map<string, Json>();
  const sessions = new Map<string, Json>();
  const claims = createClaims({ now });
  const continuing = new Set();
  // The wake gate per closed session address: a wake runs after the previous wake of that session.
  const wakeTail = new Map();
  const watchers = new AbortController();
  const proc: Json = selfProcess();
  let lastStartAt = 0;
  let pumpTimer: Json = null;
  let lastPruneAt = -Infinity;
  // In-memory read positions of the pump's peeks, keyed by lane, state file and topic; see recordPeek in lib/messaging.ts.
  const pumpPeeks = new Map();
  // Delivery workflow ids this runner has started or recovered; keeps the pump's sync claim filter (accept) off the async status query.
  const deliveryIds = new Set();
  let pumping = false;
  let pumpSkipTicks = 0;
  let pumpLimitStreak = 0;

  const sessionCfg = (project: Json, harness: Json, label: string) => ({ ...configs.get(project), peer: harness, session: label });
  const adapterOf = (harness: string) => adapters.get(harness) || fail(400, `No ${harness} adapter is loaded`);
  // Spawns per parent between the child-cap check and the claim.
  const spawning = new Map();
  // Session workflow id -> managed, from the workflow's durable input; the owned record file is writable by the session itself.
  const managedByWorkflow = new Map();
  const ownedEnv = (managed: Json, harness: Json) => {
    const base = childEnv(env);
    // A fresh ticket per open and resume: the harness binds it at SessionStart, so a grandchild that inherits it is refused.
    return managed && MANAGED_ENV_HARNESSES.has(harness) ? { ...base, ...noSubagentEnv(harness, base) } : base;
  };
  const find = (address: string) => sessions.get(address) || fail(404, "Unknown owned session");

  // The record keeps the last resume data, so a write after stop() drops the handle (a late RUN_FINISHED) still carries it.
  function save(s: Json) {
    if (s.live?.resumeData) s.record.resume = s.live.resumeData();
    writeOwned(s.cfg, s.record);
  }

  // Serializes publishes per session so rows keep their order.
  function enqueuePublish(s: Json, task: Json) {
    s.publishing = s.publishing.then(task).catch(() => {});
    return s.publishing;
  }

  function onEvent(s: Json, e: Json) {
    // A session released after its start was cancelled stays ended; its harness's late run events must not reopen it.
    if (s.released) return;
    // Once the record is ended the session is closed for good; late harness events must not reopen it on disk.
    if (s.record.status === "ended") return log(`${s.record.harness}: dropped event (session ended)`);
    const problem = eventProblem(e);
    if (problem) return log(`${s.record.harness}: dropped event (${problem})`);
    const r = s.record;
    if ((e.type === EventType.RUN_STARTED || e.type === EventType.RUN_FINISHED) && e.threadId !== r.address) {
      return log(`${r.harness}: dropped event (wrong threadId)`);
    }
    const limit = e.type === EventType.CUSTOM && e.name === LIMIT ? e.value : e.type === EventType.RUN_ERROR ? limitFromRunError(r.harness, e.message, e.metadata?.aiCollab) : null;
    switch (e.type) {
      case EventType.RUN_STARTED:
        r.status = "running";
        r.run = { id: e.runId, startedAt: now() };
        s.lastReply = undefined;
        delete r.cut;
        save(s);
        break;
      case EventType.TEXT_MESSAGE_CHUNK:
        if ((r.patternRun || r.spawn) && e.role === "assistant") {
          const previous = s.lastReply?.id === e.messageId ? s.lastReply.text : "";
          s.lastReply = { id: e.messageId, text: (previous + (e.delta ?? "")).slice(-4096) };
        }
        break;
      case EventType.RUN_FINISHED:
      case EventType.RUN_ERROR:
        r.status = "idle";
        r.run = null;
        for (const card of [...r.approvals]) closeApproval(s, card.id, "cancelled");
        save(s);
        if (e.type === EventType.RUN_ERROR) s.finished.set(e.metadata.aiCollab.runId, { outcome: "error", message: e.message, ...(r.builder && isBlockingLimit(limit) ? { usageLimit: true } : {}) });
        else {
          const outcome = e.outcome?.type ?? "success";
          const handoff = outcome === "success" ? patternHandoff(s.lastReply?.text) : undefined;
          const landFinish = outcome === "success" && r.patternRun ? landFinishRequest(s.lastReply?.text) : undefined;
          s.finished.set(e.runId, { outcome, ...(handoff ? { handoff } : {}), ...(landFinish ? { landFinish } : {}) });
        }
        s.wake();
        break;
    }
    if (e.type === EventType.CUSTOM && e.name === APPROVAL_REQUESTED) {
      const request = e.value;
      const id = randomBytes(6).toString("hex");
      const card = { id, interruptId: request.interruptId, tool: request.toolCallName, summary: request.summary };
      r.approvals.push(card);
      s.pending.set(id, { ...card, questions: request.questions });
      save(s);
      // An unanswered card is denied after approvalMs.
      const timer = setTimeout(() => respond(r.address, id, { decision: "deny" }).catch((error: Json) => log(`approval timeout failed: ${error.message}`)), approvalMs);
      timer.unref();
      s.timers.set(id, timer);
      enqueuePublish(s, () => publishApproval(s.cfg, r.harness, { ...card, questions: request.questions }, approvalMs).catch((error: Json) => log(`approval publish failed: ${error.message}`)));
      return;
    }
    if (e.type === EventType.CUSTOM && e.name === APPROVAL_RESOLVED) {
      const card = r.approvals.find((a: Json) => a.interruptId === e.value.interruptId);
      if (card) closeApproval(s, card.id, e.value.reason);
      return;
    }
    // A harness limit. A builder is retried by its supervisor, so it does not also raise a choice card.
    // Any other session starts the configured fallback (Cursor DeepSeek unless defaults say otherwise) and does not ask.
    if (limit && !r.builder) enqueuePublish(s, () => alertLimit(s.cfg, { harness: r.harness, limit, auto: true }).catch((error: Json) => log(`limit alert failed: ${error.message}`)));
    const system = e.type === EventType.RUN_STARTED && s.systemPrompt === true;
    if (e.type === EventType.RUN_STARTED) delete s.systemPrompt;
    enqueuePublish(s, () => publishEvent(s.cfg, r.harness, e, { system }));
  }

  function closeApproval(s: Json, id: Json, reason: Json) {
    if (!s.record.approvals.some((a: Json) => a.id === id)) return;
    s.record.approvals = s.record.approvals.filter((a: Json) => a.id !== id);
    s.pending.delete(id);
    clearTimeout(s.timers.get(id));
    s.timers.delete(id);
    save(s);
    enqueuePublish(s, () => publishApprovalEnd(s.cfg, id, reason).catch(() => {}));
  }

  // The adapter context; events wait for the holder's session, which exists once the session is claimed.
  function contextFor(holder: Json, harness: string, signal: Json) {
    return {
      signal,
      log: (message: Json) => log(`${harness}: ${message}`),
      emit: (e: Json) => (holder.s ? onEvent(holder.s, e) : log(`${harness}: event before claim dropped`)),
    };
  }

  // The workflow's durable input decides; with no workflow row, fail closed on the owned record or the registry entry.
  function managedFor(record: Json) {
    const known = managedByWorkflow.get(record.workflowId);
    if (known !== undefined) return known;
    if (record.managed === true) return true;
    const cfg = configs.get(record.project);
    return Boolean(cfg?.enabled && listSessions(cfg).some((e) => e.id === record.address && e.managed === true));
  }

  // The in-memory session for a claimed record; built fresh on every workflow execution, replay included.
  function runtime(wf: Json, record: Json, holder: Json) {
    if (managedFor(record)) record.managed = true;
    else delete record.managed;
    let wakeAll = () => {};
    const s: Json = {
      record, cfg: sessionCfg(record.project, record.harness, record.label), live: holder.live || null, pending: new Map(), timers: new Map(),
      publishing: Promise.resolve(), finished: new Map(), signal: wf.signal,
      wake: () => wakeAll(),
      changed: () => new Promise<void>((resolve) => { wakeAll = resolve; }),
    };
    for (const card of record.approvals) s.pending.set(card.id, card);
    holder.s = s;
    sessions.set(record.address, s);
    // A session restored after a restart has no handle: its adapter rebuilds the sandbox claim the restart lost.
    if (!holder.live && record.status !== "ended") {
      try { adapters.get(record.harness)?.restore?.(record, contextFor(holder, record.harness, wf.signal), ownedEnv(record.managed, record.harness)); } catch (error: Json) { log(`${record.harness}: could not restore ${record.address}: ${error.message}`); }
    }
    return s;
  }

  // The live handle, resuming the native session for the next input when this execution has none (after a restart).
  // A sandboxed pattern member's LAND_FINISH: the host checks and finishes its run branch; the result goes to its timeline.
  async function finishSandboxedMember(s: Json, staged: Json, request: Json) {
    const { project, harness, patternRun } = s.record;
    try {
      if (request.error) throw new Error(request.error);
      const handle = await liveHandle(s, staged);
      const result = await finishMemberBranch({
        record: s.record, run: runStatus(patternConfig(project), patternRun), root: projectRoot(project, env),
        proof: request.proof, tasks: openTasks(project, env),
        syncBack: () => (handle.syncBack ? handle.syncBack() : Promise.reject(new Error(`${harness} cannot copy sandbox work to the host`))),
      });
      await enqueuePublish(s, () => publishEvent(s.cfg, harness, { type: EventType.CUSTOM, name: NOTICE, value: "land finish: " + describeFinish(result) }));
    } catch (error: Json) {
      await enqueuePublish(s, () => publishEvent(s.cfg, harness, { type: EventType.CUSTOM, name: ERROR, value: "land finish refused: " + error.message }));
    }
  }

  async function liveHandle(s: Json, staged?: Json) {
    if (s.live) return s.live;
    if (s.record.status === "ended") fail(409, "The owned session has ended");
    if (s.record.builder && !staged) fail(409, "The builder sandbox session requires its staged launcher");
    const adapter = adapterOf(s.record.harness);
    if (adapter.capabilities.resume === "none") fail(409, `${s.record.harness} sessions cannot resume`);
    s.resuming ??= (async () => {
      // The harness's SessionStart reads this record, so the disk must already show the live status the runner holds.
      save(s);
      // The owned record's /permission value first, else the registry entry's (setNextPermission), for this resume only.
      const cfg = configs.get(s.record.project);
      const claudePermission = s.record.claudePermission ?? (cfg ? nextPermission(cfg, { id: `${s.record.harness}#${s.record.label}`, label: s.record.label }) : undefined);
      s.live = await adapter.resume({ ...s.record, ...(claudePermission ? { claudePermission } : {}) }, contextFor({ s }, s.record.harness, s.signal), ownedEnv(s.record.managed, s.record.harness), staged);
      save(s);
      return s.live;
    })().finally(() => { s.resuming = null; });
    return s.resuming;
  }

  // Resolves when runId ends.
  async function waitRun(s: Json, runId: string) {
    for (;;) {
      if (s.finished.has(runId)) return s.finished.get(runId);
      if (s.signal.aborted) throw s.signal.reason;
      await Promise.race([s.changed(), new Promise((_, reject) => s.signal.addEventListener("abort", () => reject(s.signal.reason), { once: true }))]);
    }
  }

  // Marks a run the runner can no longer finish as interrupted and closes its approvals; never resends.
  async function cutRun(s: Json, runId: string | null, reason: Json) {
    const r = s.record;
    for (const card of [...r.approvals]) closeApproval(s, card.id, "cancelled");
    r.cut = { runId: runId || "unsent", at: now(), reason };
    r.status = "idle";
    r.run = null;
    save(s);
    await enqueuePublish(s, () => publishEvent(s.cfg, r.harness, {
      type: EventType.RUN_FINISHED, threadId: r.address, runId: runId || "unsent",
      outcome: { type: "cancelled" }, metadata: { aiCollab: { reason } },
    }));
    return { outcome: "cancelled", cut: true };
  }

  async function endSession(s: Json, reason: Json) {
    for (const card of [...s.record.approvals]) closeApproval(s, card.id, "cancelled");
    if (s.live) await s.live.close().catch(() => {});
    else await Promise.resolve(adapters.get(s.record.harness)?.release?.(s.record)).catch((error: Json) => log(`${s.record.harness}: could not release ${s.record.address}: ${error.message}`));
    s.live = null;
    s.record.status = "ended";
    s.record.run = null;
    save(s);
    await recordSession(s.cfg, { id: s.record.nativeId, cwd: s.record.cwd, harness: s.record.harness, event: "ended" }).catch(() => {});
    await enqueuePublish(s, () => publishEnded(s.cfg, s.record.harness, reason));
    return { ended: reason };
  }

  // A spawned child's run ended: its parent gets the result as a direct message from the child (lib/spawn.ts spawnReport).
  async function reportToParent(s: Json, finished: Json) {
    const reply = finished?.outcome === "success" ? s.lastReply?.text ?? "" : finished?.message ?? "";
    const text = finished?.merge ? `${finished.merge}\n${reply}` : reply;
    await sendMessage(s.cfg, s.record.parent, spawnReport(s.record.address, finished?.outcome ?? "unknown", text))
      .catch((error: Json) => log(`spawn report failed: ${error.message}`));
  }

  // The branch checked out where the parent runs now: its owned record, else its registry entry (hooks keep cwd current).
  async function parentCheckoutBranch(project: Json, parent: Json): Promise<string | null> {
    const cwd = sessions.get(parent)?.record.cwd ?? listSessions(configs.get(project)).find((e: Json) => e.id === parent)?.cwd;
    const run = cwd && hostGit();
    return run ? parentBranch(run, cwd) : null;
  }

  // Git on the host as lib/sessions/git-refs.ts runs it, or null when git is missing.
  function hostGit() {
    const gitFile = findExecutable("git", childEnv(env).PATH);
    return gitFile ? gitRunner(gitFile, childEnv(env)) : null;
  }

  // Merges a spawned child's commits into the branch it was cut from; a failure becomes the report line, never a throw.
  // An OpenShell child's commits come back to its host worktree first; its branch stays as the sandbox has it (docs/threads.md).
  async function mergeChild(s: Json): Promise<string> {
    const run = hostGit();
    if (!run) return "not merged: git is not installed";
    const boxed = s.record.place === "openshell";
    try {
      if (boxed) {
        if (!s.live?.syncBack) return `not merged: ${s.record.harness} cannot copy sandbox work to the host`;
        await s.live.syncBack();
      }
      return await mergeIntoParent(run, s.record.cwd, s.record.spawn.mergeInto, { keepBranch: boxed });
    } catch (error: Json) {
      return `not merged: ${error.message}`;
    }
  }

  // The folder a session runs in: the project root, a fresh worktree, or (OpenShell) a worktree the sandbox syncs.
  async function placeCwd(project: Json, harness: string, place: Json, patternRun: Json, pick: Json = {}) {
    let root;
    try { root = projectRoot(project, env); } catch (error: Json) { fail(400, error.message); }
    if (place === "folder") return root;
    const adapter = adapterOf(harness);
    if (!(adapter.capabilities.places ?? ["folder", "worktree"]).includes(place)) fail(400, `${harness} owned sessions cannot use place ${place} yet`);
    if (pick.existing) return pick.existing;
    const base = patternRun ? { name: "team-" + patternRun, branch: "team/" + patternRun } : worktreeNames(harness, now());
    const gitFile = findExecutable("git", childEnv(env).PATH);
    if (!gitFile) fail(500, "git is not installed");
    if (patternRun && existsSync(join(root, ".claude", "worktrees", base.name, ".git"))) return join(root, ".claude", "worktrees", base.name);
    // Names have one-second resolution and parallel spawns skip the start gap, so a failed add retries under a fresh suffix.
    let code: Json = 0;
    for (let attempt = 0; attempt < WORKTREE_ATTEMPTS; attempt++) {
      const suffix = attempt === 0 || patternRun ? "" : "-" + randomBytes(3).toString("hex");
      const cwd = join(root, ".claude", "worktrees", base.name + suffix);
      code = await git(gitFile, ["-C", root, "worktree", "add", "-b", pick.branch ?? base.branch + suffix, cwd, ...(pick.base ? [pick.base] : [])], { cwd: root, env: childEnv(env) });
      if (code === 0) return cwd;
      if (patternRun) break;
    }
    fail(500, `git worktree add exited ${code}`);
  }

  // A picked base (resolved to a sha), new branch or existing worktree, checked against the project's git; worktree starts only.
  async function startPick(project: Json, place: Json, given: Json) {
    const named = Object.values(given).some((value) => value !== undefined && value !== null && value !== "");
    if (!named) return {};
    if (place !== "worktree") fail(400, "base, branch and worktreePath need place worktree");
    let root;
    try { root = projectRoot(project, env); } catch (error: Json) { fail(400, error.message); }
    const picked = await pickedWorktree(root, given, childEnv(env));
    if (picked.error) fail(400, picked.error);
    return picked;
  }

  /**
   * The place a start gets when the caller names none: defaults.json startPlace (default openshell) when this harness's
   * adapter can run there and openshell is installed, else the project folder. A Codex adapter that cannot stage its
   * own sandbox runs in OpenShell only as a builder.
   */
  function defaultPlace(harness: string) {
    const preferred = startPlaceSetting(env);
    if (preferred === "folder") return "folder";
    const places = adapterOf(harness).capabilities.places ?? ["folder", "worktree"];
    if (!places.includes(preferred)) return "folder";
    if (preferred !== "openshell") return preferred;
    if (!openshellStarts(harness)) return "folder";
    return openshellInstalled() ? "openshell" : "folder";
  }

  function openshellInstalled() {
    const bin = env.AI_COLLAB_OPENSHELL_BIN || "openshell";
    return Boolean(bin.startsWith("/") ? existsSync(bin) : findExecutable(bin, childEnv(env).PATH));
  }

  // Codex in OpenShell needs a launcher: a builder's, or one its adapter stages itself (capabilities.openshellStarts).
  function openshellStarts(harness: string) {
    return harness !== "codex" || adapterOf(harness).capabilities.openshellStarts === true;
  }

  function checkOpenShellLaunch(harness: string, place: Json, builder?: Json) {
    if (place === "openshell" && !builder && !openshellStarts(harness)) {
      fail(400, "Codex OpenShell starts require a tracked builder to prepare the launcher");
    }
  }

  // The durable session workflow: place → open → claim, then one run.send/run.wait pair per input until closed.
  async function sessionWorkflow(wf: Json, input: Json) {
    const { project, harness, place, permissionMode, model, codeMode, taskId, patternRun, builder, continuation, managed, parent, spawn, pick } = input;
    managedByWorkflow.set(wf.id, managed === true);
    // Fields a managed or spawned session adds to its owned record; none for an operator start.
    const family = { ...(managed ? { managed: true } : {}), ...(parent ? { parent } : {}), ...(spawn ? { spawn } : {}) };
    checkOpenShellLaunch(harness, place, builder);
    const adapter = adapterOf(harness);
    const holder: Json = { s: null, live: null };
    const staged = builder && await wf.step("builder.stage", async () => {
      try {
        return await stageOwnedBuilder(builder, env, log);
      } catch (error: Json) {
        return { failed: error.message };
      }
    });
    if (staged?.failed) {
      await wf.step("builder.fail", () => finishOwnedBuilder(builder, null, 1, env, log, staged.failed));
      return { ended: staged.failed };
    }
    const cwd = await wf.step("place", () => builder?.worktree ?? continuation?.worktree ?? placeCwd(project, harness, place, patternRun, pick));
    const opened = await wf.step("open", async () => {
      // An adapter that starts its child before returning (Claude) calls beforeStart with the native id: the owned record exists first.
      let openingLabel;
      const beforeStart = (nativeId: Json) => {
        const childLabel = sessionLabel(nativeId);
        openingLabel = childLabel;
        writeOwned(sessionCfg(project, harness, childLabel), {
          v: 1, label: childLabel, address: `${harness}#${childLabel}`, workflowId: wf.id, harness, nativeId, project, cwd, place, permissionMode,
          ...(model ? { model } : {}), ...(patternRun ? { patternRun } : {}), ...codeModeField(codeMode), ...(taskId ? { taskId } : {}), ...family, status: "starting", run: null, approvals: [], createdAt: now(),
        });
      };
      const options = { project, cwd, place, permissionMode, permission: permissionSettings(harness, permissionMode, place).settings, env: ownedEnv(managed, harness), beforeStart, ...(model ? { model } : {}), ...(patternRun ? { patternRun } : {}), ...codeModeField(codeMode), ...(managed ? { managed: true } : {}) };
      try {
        holder.live = await adapter.open(staged ? { ...options, cwd: staged.workdir, sandboxArgv: staged.argv } : options, contextFor(holder, harness, wf.signal));
      } catch (error: Json) {
        if (continuation && openingLabel) {
          const cfg = sessionCfg(project, harness, openingLabel);
          const record = readOwned(cfg, openingLabel);
          if (record) writeOwned(cfg, { ...record, status: "ended" });
        }
        if (builder || continuation) return { failed: error.message };
        throw error;
      }
      return { nativeId: holder.live.nativeId };
    }, builder ? {} : { onCut: () => ({ failed: "the runner stopped while the session opened" }) });
    if (opened.failed) {
      if (builder) await wf.step("builder.fail", () => finishOwnedBuilder(builder, staged, 1, env, log, opened.failed));
      return { ended: opened.failed };
    }
    const label = sessionLabel(opened.nativeId);
    const cfg = sessionCfg(project, harness, label);
    const claim = await wf.step("claim", async () => {
      const record: Json = {
        v: 1, label, address: `${harness}#${label}`, workflowId: wf.id, harness, nativeId: opened.nativeId, project, cwd, place, permissionMode,
        ...(model ? { model } : {}), ...(patternRun ? { patternRun } : {}), ...codeModeField(codeMode), ...(taskId ? { taskId } : {}), ...family, status: "idle", run: null, approvals: [], createdAt: now(),
      };
      try {
        // A continuation or spawn whose start timed out was cancelled; it must not claim a session nobody waits for.
        if (continuation || spawn) wf.signal.throwIfAborted();
        if (builder) {
          await claimOwnedBuilder(builder, record.address, env);
          record.builder = builder.id;
        }
        writeOwned(cfg, record);
        if (continuation) await openTasks(project, env).update(taskId, { owner: record.address, status: "building" });
      } catch (error: Json) {
        if (continuation || spawn) writeOwned(cfg, { ...record, status: "ended" });
        // A cancel aborts with the string "cancel", which has no message.
        if (builder || continuation || spawn) return { failed: String(error?.message ?? error) };
        throw error;
      }
      return null;
    });
    if (claim?.failed) {
      await holder.live?.close().catch(() => {});
      if (builder) await wf.step("builder.fail", () => finishOwnedBuilder(builder, staged, 1, env, log, claim.failed));
      return { ended: claim.failed };
    }
    const s = runtime(wf, readOwned(cfg, label) || fail(500, "owned record missing"), holder);
    await recordSession(cfg, { id: opened.nativeId, cwd, harness, event: "owned", proc, ...(parent ? { parent } : {}) }).catch(() => {});
    if (!wf.replaying) await enqueuePublish(s, () => publishEvent(cfg, harness, { type: EventType.CUSTOM, name: NOTICE, value: `owned session started (${permissionMode})` }));
    claims.set(wf.id, s);
    const finishBuilder = (finished?: Json) => wf.step("builder.finish", async () => {
      await s.live?.close().catch(() => {});
      s.live = null;
      await finishOwnedBuilder(builder, staged, finished?.outcome === "success" ? 0 : 1, env, log, undefined, finished?.usageLimit, wf.signal);
    });
    let next: Json = { text: spawn ? input.prompt + spawnSelfNote(s.record.address) : input.prompt, messageIds: [], system: input.system ?? Boolean(builder || patternRun) };
    for (;;) {
      if (!next) {
        const batch = await wf.recv("input", { all: true });
        if (batch.some((i: Json) => i.close)) break;
        next = merge(batch);
      }
      const turn = next;
      next = null;
      // A spawned child reports each run inside its steps, so the step sequence (the DBOS golden) is unchanged.
      const reports = Boolean(s.record.spawn && s.record.parent);
      const cut = async (runId: string | null, reason: Json) => {
        const result = await cutRun(s, runId, reason);
        if (builder) return { ...result, resumeBuilder: true };
        if (!reports) return result;
        s.record.restartResumes = (s.record.restartResumes || 0) + 1;
        save(s);
        return s.record.restartResumes <= RESTART_RESUMES ? { ...result, resumeChild: true } : result;
      };
      // A child that resumes keeps its parent waiting on the real result instead of an "interrupted" report.
      const reportCut = async (done: Json) => {
        if (reports && !done.resumeChild) await reportToParent(s, { outcome: "interrupted" });
        return done;
      };
      const sent = await wf.step("run.send", async () => {
        try {
          const handle = await liveHandle(s, staged);
          while (s.switchingModel) await s.switchingModel.catch(() => {});
          s.record.status = "running";
          save(s);
          const { system, ...message } = turn;
          s.systemPrompt = system;
          const { runId } = await handle.send(message);
          publishReceipts(s.cfg, turn.messageIds);
          return { runId };
        } catch (error: Json) {
          delete s.systemPrompt;
          if (s.signal.aborted) throw error;
          s.record.status = "idle";
          save(s);
          await enqueuePublish(s, () => publishEvent(s.cfg, harness, { type: EventType.CUSTOM, name: ERROR, value: `input not delivered: ${error.message}` }));
          if (reports) await reportToParent(s, { outcome: "error", message: `input not delivered: ${error.message}` });
          return { error: error.message };
        }
      }, { onCut: async () => reportCut(await cut(null, "runner restarted before the harness accepted the input")) });
      // The cut may fall after the harness accepted the input, so the resend asks the child to check before redoing it.
      if (sent.resumeChild) {
        next = { ...turn, text: `${RESTART_RESUME_PROMPT}\n\nThe input of that turn, in case it never arrived:\n${turn.text}` };
        continue;
      }
      if (!sent.runId && !builder) continue;
      const interrupted = () => cut(sent.runId, "runner restarted");
      const finished = sent.runId && await wf.step("run.wait", async () => {
        const done = builder && !s.live ? await interrupted() : await waitRun(s, sent.runId);
        // Inside run.wait, so the recorded op sequence is unchanged; before the handoff, so the next role finds the PR or packet.
        if (patternRun && done?.landFinish) await finishSandboxedMember(s, staged, done.landFinish);
        if (reports && done?.outcome === "success" && s.record.spawn?.mergeInto) done.merge = await mergeChild(s);
        if (reports) await reportToParent(s, done);
        return done;
      }, { onCut: async () => reportCut(await interrupted()) });
      if (finished?.resumeChild) {
        next = { text: RESTART_RESUME_PROMPT, messageIds: [], system: true };
        continue;
      }
      if (finished && !finished.cut && s.record.restartResumes) {
        delete s.record.restartResumes;
        save(s);
      }
      if (sent.resumeBuilder || finished?.resumeBuilder) {
        next = { text: builderResumePrompt(input.prompt), messageIds: [], system: true };
        continue;
      }
      if (builder) {
        await finishBuilder(finished);
        return wf.step("close", () => endSession(s, "builder finished"));
      }
      if (patternRun && finished?.handoff) {
        await wf.step("pattern.advance", async () => {
          try {
            await advancePattern({ project, id: patternRun, caller: s.record.address, ...finished.handoff });
          } catch (error: Json) {
            await enqueuePublish(s, () => publishEvent(cfg, harness, { type: EventType.CUSTOM, name: ERROR, value: "handoff rejected: " + error.message }));
          }
          return null;
        }, { onCut: () => null });
      }
    }
    if (builder) await finishBuilder();
    return wf.step("close", () => endSession(s, "closed by the operator"));
  }

  // A registry entry online in a process other than this runner: the user resumed the session outside the runner.
  const outsideOnline = (entry: Json) => entry.online === true && entry.pid !== proc?.pid;
  const seenOutside = (cfg: Json, address: string) => listSessions(cfg).some((e) => e.id === address && outsideOnline(e));

  // The owned record an adopted session gets from its registry entry: closed until the wake runs.
  function adoptedRecord(workflowId: string, project: Json, label: string, a: Json) {
    return {
      v: 1, label, address: `${a.harness}#${label}`, workflowId, harness: a.harness, nativeId: a.nativeId, project, cwd: a.cwd,
      place: "folder", permissionMode: defaultPermission(a.harness, "folder"), ...(a.model ? { model: a.model } : {}), ...(a.managed === true ? { managed: true } : {}),
      status: "ended", run: null, approvals: [], createdAt: now(),
    };
  }

  // Starts a wake for messages to one closed session; messages that arrive while it runs join its queue instead.
  async function startWake(project: Json, address: string, messages: Json, { adopt = null }: { adopt?: Json } = {}) {
    const id = `${WAKE}:${address}:${messages.at(-1).id}`;
    const started = await durable.startWorkflowOnce(WAKE, id, { project, address, messages, ...(adopt ? { adopt } : {}) });
    return started ? id : null;
  }

  // Wakes a closed session for its queued direct messages: one run takes every unseen message queued before it starts.
  // An adopted session (closed, not owned yet) gets its owned record from its registry entry first. Wakes of one address
  // run one after another; messages that arrive during a run take one more run, so one run covers each batch.
  async function wakeWorkflow(wf: Json, input: Json) {
    const { project, address, messages: first, adopt = null } = input;
    const [harness, label] = address.split("#");
    // An adopted record's workflowId is this wake's id, so its managed flag is this wake's durable input.
    if (adopt) managedByWorkflow.set(wf.id, adopt.managed === true);
    if (!adapters.has(harness)) return { status: "no-adapter", error: `no ${harness} adapter yet` };
    const previous = wakeTail.get(address);
    const gate: Json = { id: wf.id, release: () => {}, done: null };
    gate.done = new Promise<void>((resolve) => { gate.release = resolve; });
    wakeTail.set(address, gate);
    let finished = false;
    try {
      if (previous) await previous.done;
      const cfg = sessionCfg(project, harness, label);
      const scfg = { ...configs.get(project), peer: harness, session: label };
      if (adopt) {
        // Seen online outside the runner: the user resumed the session, so the hooks and live delivery take its messages.
        if (await wf.step("adopt.check", () => seenOutside(cfg, address))) return { status: "skipped-online" };
        await wf.step("adopt", () => {
          if (!readOwned(cfg, label)) writeOwned(cfg, adoptedRecord(wf.id, project, label, { ...adopt, harness }));
          return null;
        });
      }
      const record: Json = readOwned(cfg, label) || fail(500, `no owned record for ${address}`);
      const holder: Json = { s: null, live: null };
      const s = runtime(wf, record, holder);
      for (let batch = first; ; ) {
        // Reserved under this workflow's id before the turn: the hooks and the waiter skip these messages.
        let got;
        for (let tries = 0; ; tries += 1) {
          got = await wf.step("wake.reserve", () => reserveOwned(scfg, batch.map((m: Json) => m.id), { owner: wf.id }));
          if (!got.busy || tries >= 4) break;
          await wf.sleep(1000);
        }
        batch = batch.filter((m: Json) => got.owned.includes(m.id)).map((m: Json) => reservedMessage(scfg, m)).filter(Boolean);
        if (!batch.length) break;
        const shown = await cacheAttachmentsWithin(scfg, batch, { budgetMs: ATTACHMENT_BUDGET_MS });
        const text = formatInbox(shown as Json[], { session: label, peer: harness });
        const messageIds = batch.map((m: Json) => m.id);
        const sent = await wf.step("wake.send", async () => {
          // A harness that refused the turn without starting it and says the session is still closing (a codex thread
          // unloading just after the session ended) gets bounded retries, each on a freshly resumed handle. Not
          // checkpointed: a cut during a retry runs the normal onCut, which releases the batch for the hooks.
          for (let attempt = 1; ; attempt += 1) {
            try {
              s.record.status = "idle";
              await recordSession(cfg, { id: record.nativeId, cwd: record.cwd, harness, event: "owned", proc }).catch(() => {});
              const handle = await liveHandle(s);
              while (s.switchingModel) await s.switchingModel.catch(() => {});
              s.record.status = "running";
              save(s);
              const { runId } = await handle.send({ text, messageIds });
              await markDelivered(scfg, messageIds);
              publishReceipts(cfg, messageIds);
              return { runId, ...(attempt > 1 ? { attempts: attempt } : {}) };
            } catch (error: Json) {
              if (s.signal.aborted) throw error;
              s.record.status = "ended";
              save(s);
              const retry = !error.mayHaveStarted && error.retryable === true && attempt < WAKE_SEND_ATTEMPTS;
              if (retry) {
                // A refused handle is bound to the thread that refused: drop it and let the next attempt resume afresh.
                s.live = null;
                log(`${harness}: wake send attempt ${attempt} refused, retrying: ${error.message}`);
                await wf.pause(Math.min(WAKE_SEND_BACKOFF_MS * 2 ** (attempt - 1), WAKE_SEND_BACKOFF_MAX_MS));
                continue;
              }
              if (error.mayHaveStarted) {
                // The harness may have taken the turn: the batch is delivered, never resent.
                await markDelivered(scfg, messageIds);
                await enqueuePublish(s, () => publishEvent(cfg, harness, { type: EventType.CUSTOM, name: ERROR, value: `woken session may have taken the message; not resent: ${error.message}` }));
              } else {
                await releaseOwned(scfg, messageIds, wf.id);
                const tried = attempt > 1 ? ` after ${attempt} attempts` : "";
                await enqueuePublish(s, () => publishEvent(cfg, harness, { type: EventType.CUSTOM, name: ERROR, value: `woken session did not take the message${tried}: ${error.message}` }));
              }
              return { error: error.message, ...(attempt > 1 ? { attempts: attempt } : {}) };
            }
          }
        }, {
          // Never resent: a cut wake marks its run interrupted, closes the session, and releases its messages to the hooks.
          onCut: async () => {
            const out = await cutRun(s, null, "runner restarted before the harness accepted the message");
            s.record.status = "ended";
            save(s);
            await releaseOwned(scfg, messageIds, wf.id);
            return out;
          },
        });
        if (!sent.runId) break;
        await wf.step("wake.wait", () => waitRun(s, sent.runId), { onCut: () => cutRun(s, sent.runId, "runner restarted") });
        // Keep the recorded "wake.more" step from before the recv-all change: a wake replaying its
        // second+ batch meets that row at this sequence position, and a recv here threw NonDeterminismError.
        const more = await wf.step("wake.more", async () => (await wf.pending(WAKE_TOPIC)) > 0);
        if (!more) break;
        // Non-blocking recv-all: the backlog (empty included) decides whether another turn runs.
        batch = await wf.recv(WAKE_TOPIC, { all: true, timeoutSeconds: 0 });
        if (!batch.length) break;
      }
      const result = await wf.step("wake.close", () => endSession(s, "closed again after a message"));
      finished = true;
      return result;
    } finally {
      gate.release();
      if (wakeTail.get(address) === gate) wakeTail.delete(address);
      // A finished wake hands any message that arrived after its last check to a new wake.
      if (finished) {
        const late = await wf.recv(WAKE_TOPIC, { all: true, timeoutSeconds: 0 });
        if (late.length) await startWake(input.project, address, late, { adopt: input.adopt ?? null });
      }
    }
  }

  // Delivery to live sessions the runner does not own: the deps of runner/delivery.ts, each overridable through `delivery`.
  const acks = ackTracker();
  // Claude confirmation handles of unconfirmed pushes, by message id, while this runner lives.
  const inflight = new Map();
  const openCodeActive = async () => {
    const probe = await opencodeRequest("GET", "/api/session/active", { env });
    return probe.ok ? new Set(Object.keys(probe.body?.data ?? probe.body ?? {})) : null;
  };
  // A reservation outlives the Claude watch window, so the watch never runs on an expired reservation.
  const reserveTtlMs = Math.max(RESERVE_MS, claudeWindowMs(env) + 30_000);
  const deliveryDeps = {
    now,
    claim: claimInbox,
    scfgOf: (project: Json, session: Json) => ({ ...configs.get(project), peer: session.peer, session: session.session }),
    sessionOf: (project: Json, address: string) => {
      const cfg = configs.get(project);
      return (cfg && listSessions(cfg).find((s) => s.id === address && s.online)) || null;
    },
    probe: (session: Json) => (session.harness === "opencode" ? openCodeActive() : null),
    ready: async (session: Json, active: Json, project: Json) => readySession(session, active, { env, idle: sessionIdleState, cfg: configs.get(project) ?? null }),
    held: (session: Json, scfg: Json) => holdRunning(session, scfg),
    handOff: (scfg: Json, messages: Json) => handOff(scfg, messages),
    handedOff: (scfg: Json, id: Json) => handedOff(scfg, id),
    busy: async (session: Json, active: Json) => busyWithPush(session, active),
    reserve: (scfg: Json, ids: Json, { owner, allowSeen = false }: Json) => reserveOwned(scfg, ids, { owner, allowSeen, ttlMs: reserveTtlMs }),
    release: (scfg: Json, ids: Json, owner: Json) => releaseOwned(scfg, ids, owner),
    markDelivered: (scfg: Json, ids: Json) => markDelivered(scfg, ids),
    snapshot: (session: Json) => (session.harness === "claude" ? claudeSnapshot(session, { env }) : null),
    push: async (session: Json, { text, urgent, ids }: Json) => {
      const result = await pushSession(session, text, { urgent, ids }, { env });
      if (result.status === "unconfirmed") inflight.set(ids[0], result);
      return { status: result.status };
    },
    awaitConfirm: (id: Json, session: Json, snap: Json) => {
      const result = inflight.get(id);
      inflight.delete(id);
      return result?.watch ? result.watch() : claudeConfirmedSince(snap, [id]);
    },
    // Polls the transcript for the whole confirm and watch window; Claude only, other harnesses never confirm.
    waitConfirmed: async (session: Json, ids: Json, snap: Json) => {
      if (session.harness !== "claude") return false;
      const until = Date.now() + claudeWindowMs(env);
      for (;;) {
        if (claudeConfirmedSince(snap, ids)) return true;
        if (Date.now() >= until) return false;
        await delay(CONFIRM_POLL_MS);
      }
    },
    confirmedSince: (session: Json, ids: Json, snap: Json) => (session.harness === "claude" ? claudeConfirmedSince(snap, ids) : false),
    acked: async (project: Json, address: string, message: Json) => {
      const topics = new Set([receiptsTopic(project), broadcastTopic(project), inboxTopic(project, address.split("#")[0])]);
      if (typeof message.from === "string" && message.from) topics.add(inboxTopic(project, message.from.split("#")[0]));
      await acks.refresh(configs.get(project), topics);
      return acks.acked(message.id, address);
    },
    reservedMessage,
    textFor: async (scfg: Json, message: Json, attemptNo: Json) => {
      const shown = attemptNo > 1 ? { ...message, attempt: attemptNo, attempts: MAX_ATTEMPTS } : message;
      const [cached] = await cacheAttachmentsWithin(scfg, [shown], { budgetMs: ATTACHMENT_BUDGET_MS });
      return formatInbox([cached as Json], { session: scfg.session, peer: scfg.peer });
    },
  };
  const deps = { ...deliveryDeps, ...delivery };
  durable.register(DELIVERY, deliveryWorkflow(deps));
  durable.register(WAKE, wakeWorkflow);

  // An expect-reply message the dispatcher delivered keeps its redelivery: its ledger entry becomes a delivery workflow.
  async function migrateLedger(cfg: Json, started: Json) {
    const entries = readDispatchLedger(cfg);
    const left = { ...entries };
    for (const [msgId, e] of Object.entries(entries)) {
      if (!e || typeof e !== "object" || !e.message || typeof e.address !== "string") continue;
      const id = `${DELIVERY}:${e.address}:${msgId}`;
      const run = await durable.startWorkflowOnce(DELIVERY, id, { project: cfg.project, address: e.address, message: e.message, redeliver: { pushes: e.attempts ?? 1, firstAt: e.firstAt } });
      // Any existing run (cut, expired or skipped) counts: the ledger entry is spent and the pump must stop re-claiming it.
      const known = run || Boolean(await durable.status(id));
      if (known) { deliveryIds.add(id); delete left[msgId]; }
      if (run) started.push(id);
    }
    if (Object.keys(left).length !== Object.keys(entries).length) writeDispatchLedger(cfg, left);
  }

  /**
   * Starts a delivery workflow per direct message to each live, non-owned session, and at most WAKES_PER_TICK wakes per
   * tick for closed, non-owned sessions seen in the last 7 days. Finished workflows older than PRUNE_AFTER_MS are pruned
   * hourly. Resolves the started workflow ids.
   */
  async function pumpDeliveries() {
    // Ticks never overlap; after a tick that met a 429 the pump skips 1, 2, 4 ... ticks, up to PUMP_BACKOFF_MAX_TICKS.
    if (pumping) return [];
    if (pumpSkipTicks > 0) {
      pumpSkipTicks -= 1;
      return [];
    }
    pumping = true;
    try {
      const limited = new Set();
      const started = await pumpTick(limited);
      pumpLimitStreak = limited.size ? pumpLimitStreak + 1 : 0;
      pumpSkipTicks = limited.size ? Math.min(2 ** (pumpLimitStreak - 1), PUMP_BACKOFF_MAX_TICKS) : 0;
      return started;
    } finally {
      pumping = false;
    }
  }

  async function pumpTick(limited: Json) {
    const started = [];
    if (now() - lastPruneAt >= PRUNE_EVERY_MS) {
      lastPruneAt = now();
      await durable.prune([DELIVERY, WAKE], now() - PRUNE_AFTER_MS);
    }
    let wakes = 0;
    // One poll per topic and read position per tick, shared by every session that reads it; a 429 skips its topic for the tick. One tick time keeps first reads on one position.
    const memo = { poll: new Map(), limited, now: now() };
    const live = { ...memo, peek: { cursors: pumpPeeks, lane: "live" } };
    const wake = { ...memo, peek: { cursors: pumpPeeks, lane: "wake" } };
    const known = new Set();
    for (const cfg of configs.values()) {
      if (!cfg.enabled) continue;
      await migrateLedger(cfg, started);
      known.add(statePath(cfg));
      for (const session of listSessions(cfg)) {
        known.add(statePath({ ...cfg, peer: session.peer, session: session.session }));
        const owned = sessions.get(session.id);
        // An adopted session that its user resumed outside the runner loses its owned record; live delivery serves it.
        if (owned && session.online && outsideOnline(session) && owned.record.workflowId?.startsWith(`${WAKE}:`) && owned.record.status === "ended") {
          sessions.delete(session.id);
          rmSync(ownedFile(cfg, owned.record.label), { force: true });
        }
        if (sessions.has(session.id)) continue;
        const scfg = deps.scfgOf(cfg.project, session);
        if (session.online) {
          if (!PUSHED.has(session.harness)) continue;
          const fresh = (m: Json) => !deliveryIds.has(`${DELIVERY}:${session.id}:${m.id}`);
          const messages = await deps.claim(scfg, { commit: false, limit: CLAIM_LIMIT, accept: (m: Json) => direct(m) && fresh(m), ...live }).catch(() => []);
          for (const message of messages) {
            const id = `${DELIVERY}:${session.id}:${message.id}`;
            // A false return means the id already has a run (cut, expired or skipped): remember it too, or the same
            // messages are re-claimed every tick and starve the session once they leave the boot seed window.
            const startedNow = await durable.startWorkflowOnce(DELIVERY, id, { project: cfg.project, address: session.id, message });
            deliveryIds.add(id);
            if (startedNow) started.push(id);
          }
          continue;
        }
        // Resume adapters include Cursor; keep reporting missing adapters for live-push harnesses.
        const canWake = adapters.has(session.harness) || PUSHED.has(session.harness);
        if (!canWake || (session.seenAt as number) < now() - SEEN_WITHIN_MS || wakes >= WAKES_PER_TICK || wakeTail.has(session.id)) continue;
        const messages = await deps.claim(scfg, { commit: false, limit: WAKE_BATCH, accept: (m: Json) => direct(m) && m.to === session.id, ...wake }).catch(() => []);
        if (!messages.length) continue;
        // managed comes from the registry the hook wrote at an authorised start; the wake's durable input then carries it.
        const adopt = { nativeId: session.sessionId, cwd: session.cwd, ...(session.model ? { model: session.model } : {}), ...(session.managed === true ? { managed: true } : {}) };
        const id = await startWake(cfg.project, session.id, messages, { adopt });
        if (id) { started.push(id); wakes += 1; }
      }
    }
    // Read positions of sessions that are gone are dropped; a session that comes back re-reads from its committed cursor.
    for (const key of pumpPeeks.keys()) if (!known.has(key.split("\n")[1])) pumpPeeks.delete(key);
    return started;
  }

  /** Delivery and wake workflows, newest first, for the UI and the operator. */
  async function deliveries() {
    const rows = [...await durable.listNamed(DELIVERY, 100), ...await durable.listNamed(WAKE, 100)].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100);
    return { deliveries: rows.map((r) => ({
      id: r.id, kind: r.name === WAKE ? "wake" : "delivery", status: r.status, address: r.input?.address ?? null,
      messageId: r.input?.message?.id ?? r.input?.messages?.at(-1)?.id ?? null, outcome: r.output?.status ?? null, error: r.error ?? null, updatedAt: r.updatedAt,
    })) };
  }

  durable.register("session", sessionWorkflow);

  /** Starts an owned session; resolves {status:"started", session, nativeId, workflowId, detail}. */
  async function start({ project, harness, prompt, model, place: named, permissionMode, claudePermission, codeMode, taskId, builder: builderId, system = true, managed: managedInput, parent, spawn, base: pickBase, branch: pickBranch, worktreePath, mergeInto }: Json = {}, patternRun?: Json, continuation?: Json) {
    if (!configs.has(project)) fail(400, "Unknown project");
    const spawned = spawn === true;
    const depth = spawned ? spawnDepth(configs.get(project), parent) : 0;
    if (isProjectPaused(configs.get(project))) fail(409, PROJECT_PAUSED);
    const adapter = adapterOf(harness);
    const place = spawned && SPAWN_IN_OPENSHELL.has(harness) ? "openshell" : named ?? defaultPlace(harness);
    // Full access is granted only inside the container, so a missing OpenShell refuses the spawn instead of a host fallback.
    if (spawned && SPAWN_IN_OPENSHELL.has(harness) && !openshellInstalled()) {
      fail(409, `spawn_agent runs ${harness} children in OpenShell with full access, and OpenShell is not installed on the runner host (set AI_COLLAB_OPENSHELL_BIN or install openshell)`);
    }
    if (!PLACES.includes(place)) fail(400, "Unknown start place");
    // One branch per thread: a worktree or OpenShell child of a parent on a thread branch starts from it and merges back (docs/threads.md).
    const branchChild = spawned && (place === "worktree" || place === "openshell");
    if (branchChild && mergeInto === undefined && !pickBase && !pickBranch && !worktreePath) {
      const branch = await parentCheckoutBranch(project, parent);
      if (branch) [pickBase, mergeInto] = [branch, branch];
    }
    if (mergeInto !== undefined && (!branchChild || typeof mergeInto !== "string" || !BRANCH_NAME.test(mergeInto))) fail(400, "mergeInto needs a spawned worktree or OpenShell child and a branch name");
    const pick = await startPick(project, branchChild ? "worktree" : place, { base: pickBase, branch: pickBranch, worktreePath });
    // OpenShell is the boundary: every harness there runs with approvals off, whatever mode the caller named.
    // An unnamed Claude start takes the configured claudePermissionMode when it names a runner mode.
    // A non-Claude start maps claudePermission through runnerModeOfClaude when the adapter supports the mode.
    // Members (pattern, continuation, spawned, managed) default to auto; operator starts default to supervised.
    const member = Boolean(patternRun || continuation || spawned || managedInput === true);
    const claude = harness === "claude" && place !== "openshell" && permissionMode === undefined ? claudePermissionFor(harness, configs.get(project), env, { setting: claudePermission ?? (member ? "auto" : undefined) }) : {};
    if (claude.error) fail(400, claude.error);
    if (claude.flag && !runnerModeOfClaude(claude.flag)) fail(400, `claudePermissionMode ${claude.flag} has no runner mode; use default, acceptEdits, auto or bypassPermissions`);
    const configuredMode = claude.flag ? runnerModeOfClaude(claude.flag) : null;
    const mapped = harness === "claude" || typeof claudePermission !== "string" ? null : runnerModeOfClaude(claudePermission);
    const mappedMode = mapped && adapter.capabilities.permissionModes.includes(mapped) ? mapped : null;
    const memberMode = adapter.capabilities.permissionModes.includes("auto") ? "auto" : defaultPermission(harness, place);
    const mode = place === "openshell" ? OPENSHELL_PERMISSION : permissionMode ?? configuredMode ?? mappedMode ?? (member ? memberMode : "supervised");
    if (!PERMISSION_MODES.includes(mode) || !adapter.capabilities.permissionModes.includes(mode)) fail(400, `${harness} does not support permission mode ${mode}`);
    const permission = permissionSettings(harness, mode, place);
    if (permission.error) fail(400, permission.error);
    if (hostFullAccess(mode, place, env)) fail(400, hostFullAccess(mode, place, env));
    const checked: Json = checkPrompt(spawned && typeof prompt === "string" ? spawnBriefNote(prompt, parent) : prompt);
    if (checked.error) fail(400, checked.error);
    // The self note joins the first prompt once the address is known; every label is 16 hex digits, so its length is known now.
    const selfNote = spawned ? spawnSelfNote(`${harness}#${"0".repeat(16)}`).length : 0;
    if (checked.text.length + selfNote > PROMPT_MAX_CHARS) fail(400, `The brief is ${checked.text.length + selfNote - PROMPT_MAX_CHARS} characters over the ${PROMPT_MAX_CHARS}-character first prompt once the spawn notes are added`);
    if (model !== undefined && (typeof model !== "string" || !MODEL.test(model))) fail(400, "Invalid model name");
    if (codeMode !== undefined && parseCodeMode(codeMode) === undefined) fail(400, "codeMode must be on or off");
    if (taskId !== undefined) {
      if (typeof taskId !== "string" || !taskId) fail(400, "Invalid task id");
      if (!openTasks(project, env).list().some(task => task.id === taskId)) fail(400, "Unknown task in this project");
    }
    let builder: Json;
    if (builderId !== undefined) {
      if (harness !== "codex" || place !== "openshell" || !taskId) fail(400, "A builder requires Codex, OpenShell and a task");
      try { builder = ownedBuilder(project, builderId, env); } catch (error: Json) { fail(400, error.message); }
      if (builder.task !== taskId || builder.phase !== "starting") fail(409, "Builder already started or task mismatch");
    }
    checkOpenShellLaunch(harness, place, builder);
    // A builder passed the cap at `builder start`; any other OpenShell start that would add a sandbox is checked here.
    if (place === "openshell" && !builder) {
      const capped = await sandboxCapRefusal({ openshell: env.AI_COLLAB_OPENSHELL_BIN || "openshell", env, name: patternRun ? teamSandboxName(project, patternRun) : harnessSandboxName(harness, project) });
      if (capped) fail(409, capped);
    }
    // Spawns skip the gap; the per-parent child cap bounds their rate.
    if (!patternRun && !builder && !spawned && now() - lastStartAt < startGapMs) fail(429, "Wait 10 seconds between starts");
    if (!patternRun && !builder && !spawned) lastStartAt = now();
    const workflowId = `session-${randomUUID()}`;
    if (spawned) {
      if (liveChildren(parent) >= SPAWN_MAX_CHILDREN) fail(429, `this session already has ${SPAWN_MAX_CHILDREN} live spawned agents`);
      spawning.set(parent, new Set(spawning.get(parent)).add(workflowId));
    }
    const managed = Boolean(builder || patternRun || continuation || spawned || managedInput === true);
    const claimed = claims.take(workflowId);
    const timer = new AbortController();
    const timeout = builder ? BUILDER_START_TIMEOUT_MS : startTimeoutMs;
    let run = null;
    try {
      run = durable.startWorkflow("session", workflowId, { project, harness, place, permissionMode: mode, prompt: checked.text, system: Boolean(builder || patternRun) || system !== false, ...(continuation ? { continuation } : {}), ...(builder ? { builder } : {}), ...(taskId ? { taskId } : {}), ...(model ? { model } : {}), ...(patternRun ? { patternRun } : {}), ...(Object.keys(pick).length ? { pick } : {}), codeMode: resolveCodeMode(codeMode, env), ...(managed ? { managed: true } : {}), ...(spawned ? { parent, spawn: { depth, ...(mergeInto ? { mergeInto } : {}) } } : {}) });
      if (builder) watchBuilderFailure(workflowId, run);
      const ended = run.then((out: Json) => fail(502, `${harness} session ended at once: ${out?.ended || "no reason"}`));
      ended.catch(() => {});
      const s = await Promise.race([
        claimed,
        ended,
        delay(timeout, null, { signal: timer.signal }).then(() => fail(504, `${harness} did not open within ${timeout / 1000} s`)),
      ]);
      return { status: "started", session: s.record.address, nativeId: s.record.nativeId, workflowId, ...(taskId ? { taskId } : {}), ...(spawned ? { cwd: s.record.cwd } : {}), detail: `${harness} owned session started` };
    } catch (error: Json) {
      // A start the caller was told failed must not leave a child running: a continuation or a spawn is cancelled.
      if ((continuation || spawned) && error.status === 504) {
        await durable.cancel(workflowId).catch((cancelError: Json) => log(`could not cancel ${workflowId}: ${cancelError.message}`));
        // A claim that passed its abort check just before the cancel leaves a live record; end it once the workflow stops.
        run?.catch(() => {}).finally(() => releaseCancelled(project, workflowId));
      }
      if (error.status) throw error;
      throw Object.assign(new Error(`${harness} failed to start: ${error.message}`), { status: 502 });
    } finally {
      timer.abort();
      claims.drop(workflowId);
      if (spawned) spawning.get(parent)?.delete(workflowId);
    }
  }

  // A spawn's depth below its parent, refusing a bad parent and a chain past SPAWN_MAX_DEPTH.
  // The parent label is self-asserted, so it must name a live session: an owned one, or a registry entry whose process runs.
  function spawnDepth(cfg: Json, parent: Json) {
    if (typeof parent !== "string" || parentAddress({ AI_COLLAB_PARENT: parent }) !== parent) fail(400, "Invalid parent address");
    const owned = sessions.get(parent);
    const live = owned ? owned.record.status !== "ended" : listSessions(cfg).some((e) => e.id === parent && e.online);
    if (!live) fail(409, "spawn parent is not a live session");
    const depth = (sessions.get(parent)?.record.spawn?.depth ?? 0) + 1;
    if (depth > SPAWN_MAX_DEPTH) fail(409, "spawn depth limit reached");
    return depth;
  }

  // Spawned children of a parent that are live or still opening.
  // Ends whatever session a cancelled start's workflow claimed, so it holds no cap slot and no harness.
  async function releaseCancelled(project: Json, workflowId: string) {
    const late = [...sessions.values()].find(({ record }) => record.workflowId === workflowId && record.status !== "ended");
    if (late) {
      // Set first: endSession awaits after it marks the record ended, and a late RUN_FINISHED in that gap would reopen it.
      late.released = true;
      try {
        await endSession(late, "start timed out");
      } catch (error: Json) {
        // A part-way failure still ends it: the cap counts it until its status is ended, and its harness must stop.
        log(`could not end ${late.record.address}: ${error.message}`);
        late.record.status = "ended";
        late.record.run = null;
        await late.live?.close().catch(() => {});
        late.live = null;
        try { save(late); } catch (saveError: Json) { log(`could not save ${late.record.address}: ${saveError.message}`); }
      }
      return;
    }
    const cfg = configs.get(project);
    for (const record of cfg?.enabled ? listOwned(cfg) : []) {
      if (record.workflowId === workflowId && record.status !== "ended") writeOwned(sessionCfg(project, record.harness, record.label), { ...record, status: "ended" });
    }
  }

  function liveChildren(parent: Json) {
    // A start counts once: as its pending workflow until its session claims, then as that live session.
    const live = [...sessions.values()].filter(({ record }) => record.parent === parent && record.spawn && record.status !== "ended");
    const claimed = new Set(live.map(({ record }) => record.workflowId));
    return live.length + [...(spawning.get(parent) ?? [])].filter((id) => !claimed.has(id)).length;
  }

  async function continueBuilder({ project, taskId, harness }: Json) {
    if (!configs.has(project)) fail(400, "Unknown project");
    if (isProjectPaused(configs.get(project))) fail(409, PROJECT_PAUSED);
    if (typeof taskId !== "string" || !taskId) fail(400, "Invalid task id");
    const task = openTasks(project, env).list().find(task => task.id === taskId);
    const previous = task && stoppedBuilder(project, task, env);
    if (!previous) fail(409, "No stopped builder with a recoverable worktree");
    const address = task.owner || previous.address;
    const previousHarness = address?.split("#")[0] || previous.harness;
    if (harness === previousHarness) fail(400, "Choose a different harness");
    const key = previous.worktree;
    if (continuing.has(key) || [...sessions.values()].some(({ record }) => record.status !== "ended" && (record.cwd === key || record.address === address))) {
      fail(409, "A replacement is already starting or using this worktree");
    }
    let originalBrief = "";
    try { originalBrief = readFileSync(builderPaths(previous.id, env).brief, "utf8").split("\n## Builder sandbox\n")[0]; } catch { /* Older records may lack a brief. */ }
    const prompt = [
      `Continue task #${task.id} on branch ${previous.branch}. Inspect git status and preserve existing changes.`,
      `Previous session: ${address || previous.unit}`,
      `Latest recorded oncebitten result: ${previous.oncebitten == null ? "unavailable" : "exit " + previous.oncebitten} ${previous.checkText || ""}`,
      `Task: ${task.title}`,
      task.detail,
      task.question?.answer && `Operator decision: ${task.question.text} → ${task.question.answer.text}`,
      `Read the full task history with ai-collab task show ${task.id}. Verify your changes and update the task when finished.`,
      originalBrief,
      ...task.progress.slice(-5).map((entry: Json) => entry.text),
    ].filter(Boolean).join("\n").slice(0, 4000);
    continuing.add(key);
    try {
      return await start({ project, taskId, harness, prompt, place: "folder" }, undefined, { worktree: key });
    } finally {
      continuing.delete(key);
    }
  }

  const patternReplies = new Map();
  const replyToPattern = (request: Json, outcome: Json) => patternReplies.get(request)?.(outcome);
  const legacyPatternId = (project: Json, id: Json) => `pattern:${project}:${id}`;
  const patternConfig = (project: Json) => {
    const cfg = configs.get(project);
    if (!cfg) fail(400, "Unknown project");
    return { ...cfg, peer: "operator", session: "" };
  };

  // A run that reached done or failed closes its role sessions, so a team's sandbox is synced back and released.
  async function releasePatternSessions(project: Json, runId: string) {
    let run;
    try { run = runStatus(patternConfig(project), runId); } catch { return null; }
    const open = sessionsOfRun(run).map((address) => sessions.get(address)).filter((s) => s && s.record.status !== "ended");
    await Promise.all(open.map((s) => close(s.record.address).catch((error: Json) => log(`could not close ${s.record.address} after run ${runId}: ${error.message}`))));
    return open.length;
  }

  async function patternWorkflow(wf: Json, input: Json) {
    const reply = await runPattern(wf, input);
    // Not a durable step (replay logs must keep their steps): a restart before the workflow finishes simply releases again.
    if (reply?.status === "done" || reply?.status === "failed") {
      await releasePatternSessions(input.project, input.initial?.id ?? runIdOfPatternWorkflow(wf.id));
    }
    return reply;
  }

  async function runPattern(wf: Json, input: Json) {
    const { project } = input;
    const cfg = patternConfig(project);
    const launch = async (_cfg: Json, { patternRun, ...options }: Json) => {
      for (;;) {
        wf.signal.throwIfAborted();
        try {
          return await start({ ...options, project }, patternRun);
        } catch (error: Json) {
          if (error.status !== 429) throw error;
          await wf.pause(Math.max(1, startGapMs - (now() - lastStartAt)));
        }
      }
    };
    const notify = (address: string, text: Json) => send(address, { text });
    if (input.initial) {
      const { initial } = input;
      // Persisted step names and their order must match the old log during replay.
      let reply = await wf.step("pattern.entry", async () => {
        const started = await launchPatternRun(cfg, initial, env, launch);
        wf.signal.throwIfAborted();
        return started;
      }, { onCut: () => cutPatternRun(cfg, initial, "start") });
      replyToPattern(input.request, { reply });
      while (reply.status === "running" || reply.status === "suspended") {
        const { request, event, options } = await wf.recv("advance");
        const outcome = await wf.step("pattern.advance", async () => {
          try {
            const advanced = await applyPatternAdvance(cfg, initial.id, event, { ...options, env, now, start: launch, notify });
            wf.signal.throwIfAborted();
            return { reply: advanced };
          } catch (error: Json) {
            wf.signal.throwIfAborted();
            return { error: error.message };
          }
        }, { onCut: () => ({ reply: cutPatternRun(cfg, initial, "advance") }) });
        replyToPattern(request, outcome);
        if (outcome.reply) reply = outcome.reply;
      }
      return reply;
    }
    const visible = (advanced: Json) => {
      const reply = { ...advanced };
      delete reply.targets;
      delete reply.arrival;
      return reply;
    };
    return runPatternWorkflow(wf, input, {
      enterEntry: (_input, runId) => launchPatternRun(cfg, seedPatternRun(input, runId, now), env, launch),
      leave: async (runId, message) => {
        try {
          const advanced = await applyPatternAdvance(cfg, runId, message.event, {
            ...message.options, env, now, start: launch, notify, launchNext: false,
          });
          const targets = advanced.targets ?? [];
          return { reply: visible(advanced), launch: advanced.status === "running" && targets.length > 0, targets, arrival: advanced.arrival };
        } catch (error: Json) {
          if (wf.signal.aborted) throw error;
          return { error: error.message, launch: false };
        }
      },
      enterNext: async (runId, left) => {
        const activated = await activatePatternTargets(cfg, runId, left.targets, left.arrival, { env, start: launch, notify });
        return { reply: { ...left.reply, ...activated, handoff: left.reply?.handoff } };
      },
      cutEntry: (_input, runId) => cutPatternEntry(cfg, runId),
      cutLeave: (runId) => cutPatternLeave(cfg, runId),
      cutEnter: (runId, left) => cutPatternEnter(cfg, runId, left.targets),
      reply: replyToPattern,
    });
  }

  durable.register("pattern", patternWorkflow);

  async function waitForPattern(id: Json, submit: Json) {
    const request = randomUUID();
    const response = new Promise((resolve) => patternReplies.set(request, resolve));
    try {
      // A rejecting submit (a DBOS start guard, say) answers this request through the race; left
      // unhandled it would crash the runner instead. On success the branch never settles.
      // submit must run synchronously here: the result branch below reads the workflow it starts.
      let started;
      try { started = Promise.resolve(submit(request)); } catch (error: Json) { started = Promise.reject(error); }
      const outcome = await Promise.race([
        response,
        started.then(() => new Promise(() => {}), (error) => ({ error: `pattern submit failed: ${error.message}` })),
        durable.result(id).then((reply: Json) => ({ error: reply ? `run ${reply.id} is ${reply.status}` : "Pattern runner stopped" })),
      ]);
      if (outcome.error) fail(409, outcome.error);
      return outcome.reply;
    } finally {
      patternReplies.delete(request);
    }
  }

  async function startPattern({ project, name, task }: Json = {}) {
    const cfg = patternConfig(project);
    if (isProjectPaused(cfg)) fail(409, PROJECT_PAUSED);
    let initial: Json;
    try {
      const pattern = getPattern(cfg, name, env);
      if (!pattern.file && pattern.source !== "built-in") throw new Error("A team.dot pattern is required");
      initial = { ...(await preparePatternRun(cfg, pattern, task, env, { now, openshell: true })), runner: true };
      for (const { harness } of initial.definition.roles) {
        checkOpenShellLaunch(harness, "openshell");
        // OpenCode and openshellTeams:false adapters run in per-project sandboxes (opencode-sandbox.ts, cli-sandbox.ts), not the team sandbox.
        if (harness === "opencode" || adapterOf(harness).capabilities.openshellTeams === false || !adapterOf(harness).capabilities.places?.includes("openshell")) throw new Error(harness + " does not support OpenShell team roles");
      }
    } catch (error: Json) {
      fail(400, error.message);
    }
    if (now() - lastStartAt < startGapMs) fail(429, "Wait 10 seconds between starts");
    lastStartAt = now();
    const id = patternWorkflowId(initial.id);
    return waitForPattern(id, (request: Json) => durable.startWorkflow("pattern", id, {
      name: initial.definition.name, task: initial.task, definition: initial.definition, project, request,
    }));
  }

  async function advancePattern({ project, id, event, note, caller, override, confirmation, by }: Json = {}) {
    const cfg = patternConfig(project);
    if (typeof id !== "string" || !RUN_ID.test(id)) fail(400, "Invalid pattern run id");
    let run;
    try {
      run = runStatus(cfg, id);
    } catch {
      fail(404, "Unknown runner pattern");
    }
    const currentWorkflow = patternWorkflowId(id);
    const workflow = (await durable.status(currentWorkflow)) ? currentWorkflow : legacyPatternId(project, id);
    const status = await durable.status(workflow);
    if (!status) fail(404, "Unknown runner pattern");
    if (status.status !== "PENDING") fail(409, `run ${id} is ${run.status}`);
    if (!(override === true && typeof confirmation === "string" && RUN_ID.test(confirmation))
        && (typeof event !== "string" || !event.trim() || event.trim().length > DOT_EVENT_MAX)) fail(400, "Invalid pattern event");
    const options = {
      note: typeof note === "string" ? note.trim().slice(0, NOTE_MAX) : "",
      caller: typeof caller === "string" ? caller : "",
      override: override === true,
      confirmation: typeof confirmation === "string" ? confirmation : "",
      by: typeof by === "string" ? by.slice(0, 80) : "operator",
    };
    return waitForPattern(workflow, (request: Json) => durable.send(workflow, "advance", { request, event, options }));
  }

  /** Queues input as a durable message, or steers the running run when asked and supported. */
  async function send(address: string, { text, steer = false, messageIds = [], dedupe = null }: Json = {}) {
    const s = find(address);
    if (typeof text !== "string" || !text.trim() || text.length > TEXT_MAX) fail(400, "Enter 1–4000 characters");
    if (s.record.status === "ended") fail(409, "The owned session has ended");
    if (steer && s.record.status === "running" && adapterOf(s.record.harness).capabilities.steer) {
      const handle = await liveHandle(s);
      if (handle.steer) {
        await handle.steer({ text, messageIds });
        publishReceipts(s.cfg, messageIds);
        return { status: "steered" };
      }
    }
    const fresh = await durable.send(s.record.workflowId, "input", { text, messageIds }, { dedupe });
    if (!fresh) return { status: "duplicate" };
    return { status: s.record.status === "running" ? "queued" : "sent" };
  }

  async function interrupt(address: string) {
    const s = find(address);
    if (s.record.status !== "running") return { status: "idle" };
    await (await liveHandle(s)).interrupt();
    return { status: "interrupting" };
  }

  /**
   * Compacts an owned session's context through its harness, in place: Claude runs /compact on the live query, Codex
   * thread/compact/start, OpenCode session.compact. Resolves {status, detail, before?, after?}; a harness with no
   * outside trigger (Cursor) reports unsupported so the UI keeps its request-and-retry path.
   */
  async function compact(address: string) {
    const s = find(address);
    if (s.record.status === "ended") fail(409, "The owned session has ended");
    if (s.record.status === "running") fail(409, "The session is mid-turn; compact it once the turn ends");
    const handle = await liveHandle(s);
    if (s.switchingModel) fail(409, "Wait for the model switch to finish");
    if (!handle.compact) return { status: "unsupported", detail: `${s.record.harness} has no outside compaction trigger` };
    const counts = await handle.compact();
    const span = Number.isFinite(counts?.before) && Number.isFinite(counts?.after) ? `${counts.before} → ${counts.after} tokens.` : "";
    return { status: "succeeded", detail: `Compacted the session in place. ${span}`.trim(), ...(counts?.before !== undefined ? { before: counts.before } : {}), ...(counts?.after !== undefined ? { after: counts.after } : {}) };
  }

  async function setModel(address: string, model: Json) {
    const s = find(address);
    const r = s.record;
    if (r.harness !== "claude") fail(400, "Model switching is available for runner-owned Claude sessions");
    if (r.status !== "idle" || s.switchingModel) fail(409, "The Claude session must be idle to switch models");
    if (!modelShape(r.harness, model)) fail(400, "Select a valid Claude model");
    const fields = modelFields({ from: r.model || "default", to: model });
    if (!fields) fail(400, "Select a valid Claude model");
    if (fields.to === r.model) return { status: "Model already selected", model: r.model };
    s.switchingModel = (async () => {
      const handle = await liveHandle(s);
      if (r.status !== "idle") fail(409, "The Claude session must be idle to switch models");
      if (!handle.setModel) fail(409, "This Claude session cannot switch models");
      await handle.setModel(fields.to);
      r.model = fields.to;
      save(s);
      void enqueuePublish(s, () => publishEvent(s.cfg, r.harness, {
        type: EventType.STEP_FINISHED, stepName: "model", metadata: { aiCollab: { modelSwitch: fields } },
      }));
      return { status: "Model switched", model: r.model, detail: r.model };
    })().finally(() => { s.switchingModel = null; });
    return s.switchingModel;
  }

  /** Changes an owned session's permission mode; reached only through the control socket, never through the bus or MCP. */
  async function setMode(address: string, mode: Json) {
    const named = PERMISSION_MODES.includes(mode) ? mode : runnerModeOfClaude(mode) ?? mode;
    const s = find(address);
    const r = s.record;
    if (r.status === "ended") fail(409, "The owned session has ended");
    if (r.place === "openshell" && named !== OPENSHELL_PERMISSION) fail(400, "An OpenShell session always runs with full access");
    if (!PERMISSION_MODES.includes(named) || !adapterOf(r.harness).capabilities.permissionModes.includes(named)) fail(400, `${r.harness} does not support permission mode ${named}`);
    const permission = permissionSettings(r.harness, named, r.place);
    if (permission.error) fail(400, permission.error);
    if (hostFullAccess(named, r.place, env)) fail(400, hostFullAccess(named, r.place, env));
    const handle = await liveHandle(s);
    if (!handle.setPermissionMode) fail(409, `${r.harness} cannot change its permission mode while open`);
    await handle.setPermissionMode(named);
    const was = r.permissionMode;
    r.permissionMode = named;
    save(s);
    await enqueuePublish(s, () => publishEvent(s.cfg, r.harness, { type: EventType.CUSTOM, name: NOTICE, value: `permission mode ${was} → ${named}` }));
    return { status: "changed", permissionMode: named };
  }

  /** Answers an approval card: decision allow|deny (allow with scope "session" for the rest of the session), or answers for a choice. */
  async function respond(address: string, id: Json, { decision, answers, scope }: Json = {}) {
    const s = find(address);
    const card = s.pending.get(id);
    if (!card) fail(404, "Unknown or closed approval");
    if (!s.live) {
      closeApproval(s, id, "cancelled");
      fail(409, "The run that asked was cut; the approval is closed");
    }
    const value = answers ? { behavior: "allow", answers } : decision === "allow" ? { behavior: "allow", ...(scope === "session" ? { scope } : {}) } : decision === "deny" ? { behavior: "deny" } : null;
    if (!value) fail(400, "Decision must be allow or deny");
    // Closed first: the harness may finish the run before respond() resolves.
    closeApproval(s, id, answers ? "answered" : value.behavior === "allow" ? "allowed" : "denied");
    await s.live.respond(card.interruptId, value);
    return { status: "answered" };
  }

  function watchBuilderFailure(workflowId: string, run: Json) {
    void run.catch(async () => {
      const failed = [...sessions.values()].find(({ record }) => record.workflowId === workflowId && record.builder);
      if (failed) await reconcileFailedBuilder(failed.record);
    });
  }

  async function reconcileFailedBuilder(record: Json) {
    if (!record.builder || record.status === "ended") return;
    const workflow = await durable.status(record.workflowId);
    if (workflow?.status !== "ERROR") return;
    const reason = workflow.error || "Builder workflow failed";
    try {
      markOwnedBuilderFailed(record.project, record.builder, record.address, reason, env);
      const session = sessions.get(record.address);
      if (session) await endSession(session, reason);
      else {
        const cfg = sessionCfg(record.project, record.harness, record.label);
        writeOwned(cfg, { ...record, status: "ended", run: null, approvals: [] });
        await recordSession(cfg, { id: record.nativeId, cwd: record.cwd, harness: record.harness, event: "ended" }).catch(() => {});
      }
    } catch (error: Json) {
      log(`failed to reconcile builder ${record.builder}: ${error.message}`);
    }
  }

  /** Interrupts a running run, then ends the workflow; resolves once the session ended or CLOSE_WAIT_MS passed. */
  // close_agent: a parent closes one of its own spawned children, freeing a slot under SPAWN_MAX_CHILDREN.
  async function closeChild(address: string, parent: Json) {
    const s = find(address);
    if (!s.record.spawn || typeof parent !== "string" || s.record.parent !== parent) fail(403, `${address} is not a spawned child of ${parent}`);
    return close(address);
  }

  async function close(address: string) {
    const s = find(address);
    await reconcileFailedBuilder(s.record);
    if (s.record.status === "ended") return { status: "ended" };
    if (s.record.status === "running") await s.live?.interrupt().catch(() => {});
    await durable.send(s.record.workflowId, "input", { close: true }).catch(() => {});
    const timer = new AbortController();
    await Promise.race([durable.result(s.record.workflowId).catch(() => {}), delay(CLOSE_WAIT_MS, null, { signal: timer.signal }).catch(() => {})]);
    timer.abort();
    await reconcileFailedBuilder(s.record);
    return { status: s.record.status === "ended" ? "ended" : "closing" };
  }

  /** Re-runs PENDING session workflows from the durable log (restart rules), then watches the bus. */
  async function boot() {
    // Scheduled ticks recover too, but only session workflows hold the boot until they claim.
    const isSession = async (id: Json) => (await durable.status(id))?.name === "session";
    // Before recovery, so a recovered wake workflow knows which sessions are managed.
    for (const cfg of configs.values()) {
      for (const record of listOwned(cfg)) {
        if (!record.workflowId || managedByWorkflow.has(record.workflowId)) continue;
        const workflow = await durable.status(record.workflowId).catch(() => null);
        if (workflow?.name === "session") managedByWorkflow.set(record.workflowId, workflow.input?.managed === true);
        if (workflow?.name === WAKE && workflow.input?.adopt) managedByWorkflow.set(record.workflowId, workflow.input.adopt.managed === true);
      }
    }
    const pending = await durable.pending();
    const sessionIds = [];
    for (const id of pending) if (await isSession(id)) sessionIds.push(id);
    for (const r of await durable.listNamed(DELIVERY, 100)) deliveryIds.add(r.id); // the pump's fresh filter survives restarts for the recent window
    const claimed = sessionIds.map((id) => claims.take(id));
    const ids = await durable.recover();
    for (const id of sessionIds) watchBuilderFailure(id, durable.result(id));
    const waits = sessionIds.map((id, i) => Promise.race([claimed[i], durable.result(id).catch(() => {})]));
    const timer = new AbortController();
    await Promise.race([Promise.all(waits), delay(START_TIMEOUT_MS, null, { signal: timer.signal }).catch(() => {})]);
    timer.abort();
    for (const id of sessionIds) claims.drop(id);
    for (const cfg of configs.values()) {
      for (const record of listOwned(cfg)) await reconcileFailedBuilder(record);
    }
    if (watch) for (const cfg of configs.values()) void watchProject(cfg);
    if (watch && pumpMs > 0) {
      pumpTimer = setInterval(() => pumpDeliveries().catch((error: Json) => log(`delivery pump failed: ${error.message}`)), pumpMs);
      pumpTimer.unref();
    }
    const recovered = [];
    for (const id of ids) if (await isSession(id)) recovered.push(id);
    return recovered;
  }

  /** Runs a schedule's tick now; fails 404 for an unknown schedule and 429 within MANUAL_RUN_GAP_MS of the last one. */
  function runSchedule(name: Json, caller = "unknown") {
    if (!durable.hasSchedule(name)) fail(404, "Unknown schedule");
    const at = now();
    if (at - (manualAt.get(name) ?? -Infinity) < MANUAL_RUN_GAP_MS) fail(429, `Wait ${MANUAL_RUN_GAP_MS / 1000} seconds between manual runs`);
    manualAt.set(name, at);
    return durable.runScheduled(name).then((result: Json) => {
      log(`manual run of ${name} as ${result.id} (${result.status}) by ${caller}`);
      return result;
    });
  }

  // A bus event: a phone reply to an owned approval, or a message for an owned session.
  async function onNtfy(cfg: Json, topic: Json, ev: Json) {
    const reply = parsePhoneReply(ev.message || "");
    if (reply && topic === broadcastTopic(cfg.project)) {
      if (!APPROVAL_ID.test(reply.id)) return;
      for (const s of sessions.values()) {
        const card = s.pending.get(reply.id);
        const decision = card ? replyDecision(card, reply.answer) : null;
        if (decision) await respond(s.record.address, reply.id, decision.answers ? { answers: decision.answers } : { decision: decision.behavior, ...(decision.scope ? { scope: decision.scope } : {}) }).catch((error: Json) => log(`reply failed: ${error.message}`));
      }
      return;
    }
    const broadcast = topic === broadcastTopic(cfg.project);
    const m = parseEnvelope(ev.message || "");
    if (!m && broadcast) return deliverPlain(cfg, ev);
    if (m?.kind !== "msg" || typeof m.body !== "string" || !isValidName(m.from)) return;
    const sender = typeof m.session === "string" && SESSION_LABEL.test(m.session) ? m.session : "";
    const attachment = attachmentOf(ev);
    const item = (s: Json) => ({
      id: ev.id, from: sender ? `${m.from}#${sender}` : m.from, to: s.record.address, ts: typeof m.ts === "string" ? m.ts : "", body: m.body,
      ...(m.operatorThread === true && m.from === "operator" ? { operatorThread: true } : {}),
      ...(m.from === "operator" && m.system === true ? { system: true } : {}),
      ...(m.from === "operator" && broadcast ? { operatorBroadcast: true } : {}),
      ...(m.urgent === true ? { urgent: true } : {}),
      ...(m.from === "operator" && typeof m.mentionedIn === "string" ? { mentionedIn: m.mentionedIn } : {}),
      ...(attachment ? { attachment: localizedAttachment(cfg, attachment) } : {}),
    });
    if (typeof m.toSession === "string") {
      // A direct message or @mention for one owned session.
      if (!SESSION_LABEL.test(m.toSession)) return;
      const s = sessions.get(`${m.to}#${m.toSession}`);
      if (s) await deliver(cfg, s, item(s), m.urgent === true, m.from, sender, true);
    } else if (broadcast && m.to === "all") {
      // A project-chat post reaches an owned session only when it @mentions that session or its harness.
      // A start-only post addresses the session its tag starts. A direct message is handled above and always wakes.
      if (m.from === "operator" && m.startOnly === true) return;
      for (const s of sessions.values()) {
        if (!mentionsAgent(m.body, { peer: s.record.harness, session: s.record.label })) continue;
        await deliver(cfg, s, item(s), m.urgent === true, m.from, sender, true);
      }
    }
  }

  // Raw project-chat text reaches an owned session only when it @mentions that session or its harness.
  async function deliverPlain(cfg: Json, ev: Json) {
    const text = (ev.message || "").trim();
    if (!text || parseQuestionText(text)) return;
    for (const s of sessions.values()) {
      if (!mentionsAgent(text, { peer: s.record.harness, session: s.record.label })) continue;
      await deliver(cfg, s, { id: ev.id, from: "ntfy", to: "all", ts: "", body: text.slice(0, TEXT_MAX), operatorBroadcast: true }, false, "ntfy", "", true);
    }
  }

  // A direct message to a closed owned session wakes it. While a wake runs, the message joins that wake's queue.
  // A session seen online outside the runner is left to the hooks and live delivery.
  async function wake(cfg: Json, s: Json, message: Json) {
    const address = s.record.address;
    if (seenOutside(cfg, address)) return;
    const inflight = wakeTail.get(address);
    if (inflight) {
      await durable.send(inflight.id, WAKE_TOPIC, message, { dedupe: `ntfy:${message.id}` });
      return;
    }
    await startWake(cfg.project, address, [message]);
  }

  // Queues one inbox item as the session's next input; skips other projects and the session's own messages.
  async function deliver(cfg: Json, s: Json, message: Json, urgent: Json, from: Json, sender: Json, isDirect = false) {
    if (s.record.project !== cfg.project) return;
    if (from === s.record.harness && (!sender || sender === s.record.label)) return;
    if (s.record.status === "ended" || wakeTail.has(s.record.address)) {
      if (isDirect && !s.record.builder) await wake(cfg, s, message);
      return;
    }
    // A live session gets the message only after any attachment is in the shared cache, so it reads the file
    // rather than downloading it again.
    const [cached] = await cacheAttachmentsWithin({ ...cfg, peer: s.record.harness, session: s.record.label }, [message], { budgetMs: ATTACHMENT_BUDGET_MS });
    const text = formatInbox([cached as Json], { session: s.record.label, peer: s.record.harness });
    await send(s.record.address, { text, steer: urgent, messageIds: [message.id], dedupe: `ntfy:${message.id}:${s.record.label}` }).catch((error: Json) => log(`delivery failed: ${error.message}`));
  }

  // Streams the broadcast topic and each loaded harness's inbox from the stored cursor, reconnecting with backoff.
  async function watchProject(cfg: Json) {
    const topics = [broadcastTopic(cfg.project), ...[...adapters.keys()].map((h) => inboxTopic(cfg.project, h))];
    const key = `ntfy-cursor:${cfg.project}`;
    let since = (await durable.getKv(key)) || String(Math.floor(now() / 1000));
    let backoff = 1000;
    while (!watchers.signal.aborted) {
      try {
        const onReset = () => log(`bus replayed ${cfg.project} from the oldest event (unknown cursor)`);
        for await (const ev of streamEvents(cfg, topics, { since, signal: watchers.signal, onOpen: () => { backoff = 1000; }, onReset })) {
          await onNtfy(cfg, ev.topic, ev);
          since = ev.id;
          await durable.setKv(key, since);
        }
      } catch { /* outage or idle timeout */ }
      if (watchers.signal.aborted) break;
      await delay(backoff, undefined, { signal: watchers.signal }).catch(() => {});
      backoff = Math.min(backoff * 2, STREAM_RETRY_MAX_MS);
    }
  }

  /** Stops watching, aborts workflows where they wait (open steps are cut at the next boot), closes handles. */
  async function stop() {
    clearInterval(pumpTimer);
    pumpTimer = null;
    watchers.abort();
    await durable.close();
    for (const s of sessions.values()) {
      for (const timer of s.timers.values()) clearTimeout(timer);
      s.timers.clear();
      await s.live?.close().catch(() => {});
      s.live = null;
      await s.publishing;
    }
    for (const adapter of adapters.values()) await adapter.shutdown().catch(() => {});
  }

  async function harnesses() {
    return Promise.all([...adapters.values()].map(async (a) => ({ harness: a.harness, capabilities: a.capabilities, ...(await a.available(env).catch((e: Json) => ({ ok: false, detail: e.message }))) })));
  }

  const entryOf = (name: Json) => {
    const entry = scheduleEntries.find((item) => item.name === name);
    if (!entry) return {};
    const session = sessionOfCommand(entry.command);
    return { command: entry.command, cwd: entry.cwd, ...(session ? { session } : {}) };
  };

  return {
    start, continueBuilder, startPattern, advancePattern, send, interrupt, compact, respond, setModel, setMode, close, closeChild, boot, stop, harnesses, deliveries, pump: pumpDeliveries,
    list: () => [...sessions.values()].map(view),
    // Each schedule with the command and folder its schedules.json entry names, and the session it resumes.
    schedules: async () => ({ schedules: (await durable.schedules()).map((s: Json) => ({ ...s, ...entryOf(s.name) })), configError: scheduleErrors }),
    // One schedule's ticks, each with the session its command resumes so the UI can open that run's timeline.
    scheduleRuns: async (name: Json) => {
      const session = sessionOfCommand(scheduleEntries.find((item) => item.name === name)?.command);
      return (await durable.scheduleRuns(name)).map((run: Json) => (session ? { ...run, session } : run));
    },
    runSchedule,
    get: (address: string) => view(find(address)),
    models: (harness: string) => adapterOf(harness).listModels(env),
    commands: (harness: string, project: Json) => {
      if (!configs.has(project)) fail(400, "Unknown project");
      return adapterOf(harness).listCommands(projectRoot(project, env), env);
    },
    context: async (address: string) => (await (await liveHandle(find(address))).contextUsage?.()) ?? null,
    settle: () => Promise.all([...sessions.values()].map((s) => s.publishing)),
  };
}
