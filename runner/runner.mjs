// Runner core: one durable "session" workflow per owned session; control calls and ntfy input become durable messages.
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { EventType } from "@ag-ui/core";
import { DOT_EVENT_MAX } from "../lib/dot.mjs";
import { getPattern } from "../lib/patterns.mjs";
import { applyPatternAdvance, cutPatternRun, launchPatternRun, NOTE_MAX, preparePatternRun, RUN_ID, runStatus } from "../lib/pattern-runs.mjs";
import { statePath } from "../lib/state.mjs";
import { SESSION_LABEL, broadcastTopic, inboxTopic, isValidName, receiptsTopic, sessionLabel } from "../lib/config.mjs";
import { RESERVE_MS, ATTACHMENT_BUDGET_MS, claimInbox, markDelivered, parseEnvelope, releaseOwned, reserveOwned, reservedMessage } from "../lib/inbox.mjs";
import { parsePhoneReply, parseQuestionText } from "../lib/questions.mjs";
import { replyDecision, APPROVAL_ID } from "../lib/approvals.mjs";
import { formatInbox, identityLine } from "../lib/format.mjs";
import { attachmentOf, cacheAttachmentsWithin, localizedAttachment } from "../lib/attachment-cache.mjs";
import { streamEvents } from "../lib/ntfy.mjs";
import { listSessions, recordSession } from "../lib/sessions.mjs";
import { claudeConfirmedSince, claudeSnapshot, claudeWindowMs } from "../lib/claude-socket.mjs";
import { ackTracker, direct, MAX_ATTEMPTS, PUSHED, pushSession, readDispatchLedger, readySession, writeDispatchLedger } from "../lib/deliver-push.mjs";
import { sessionIdleState } from "../lib/idle.mjs";
import { opencodeRequest } from "../lib/opencode-api.mjs";
import { BUILDER_START_TIMEOUT_MS, ownedBuilder, stageOwnedBuilder, claimOwnedBuilder, finishOwnedBuilder } from "../lib/builder.mjs";
import { childEnv, checkPrompt, findExecutable, modelShape, projectRoot, worktreeNames } from "../lib/start.mjs";
import { parseCodeMode, resolveCodeMode } from "../lib/code-mode.mjs";
import { openTasks } from "../lib/tasks.mjs";
import { ownedFile, readOwned, writeOwned } from "../lib/owned.mjs";
import { modelFields } from "../lib/session-events.mjs";
import { limitFromRunError } from "../lib/limits.mjs";
import { alertLimit } from "../lib/limit-alert.mjs";
import { APPROVAL_REQUESTED, APPROVAL_RESOLVED, ERROR, LIMIT, NOTICE, PERMISSION_MODES, PLACES, approvalTimeoutMs, defaultPermission, eventProblem, OPENSHELL_PERMISSION, permissionSettings } from "./contract.mjs";
import { sessionOfCommand } from "../lib/schedule-session.mjs";
import { DELIVERY, deliveryWorkflow } from "./delivery.mjs";
import { publishApproval, publishApprovalEnd, publishEnded, publishEvent, publishReceipts } from "./publish.mjs";

export const START_TIMEOUT_MS = 60_000;
export const START_GAP_MS = 10_000;
export const CLOSE_WAIT_MS = 10_000;
export const MANUAL_RUN_GAP_MS = 10_000;
export const WAKE = "wake";
// How often the runner looks for direct messages to live sessions that have no delivery workflow yet.
export const PUMP_MS = 5000;
// Steps and messages of finished workflows older than the ntfy cache window (at most 720 min) are pruned hourly;
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
// Longest pause, in pump ticks, after a tick that met a 429 from ntfy.
const PUMP_BACKOFF_MAX_TICKS = 6;
const STREAM_RETRY_MAX_MS = 30_000;
const TEXT_MAX = 4000;
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:/[\]-]{0,119}$/;

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

// This process as {pid, start}, the shape lib/process.mjs isRunning checks.
function selfProcess() {
  try {
    const text = readFileSync("/proc/self/stat", "utf8");
    return { pid: process.pid, start: text.slice(text.lastIndexOf(")") + 2).split(" ")[19] };
  } catch {
    return null;
  }
}

function runGit(file, args, options) {
  return new Promise((resolve) => execFile(file, args, options, (error) => resolve(error ? (error.code ?? 1) : 0)));
}

// Queued inputs as one run: texts joined, message ids merged.
const merge = (batch) => ({ text: batch.map((i) => i.text).join("\n\n"), messageIds: batch.flatMap((i) => i.messageIds || []) });
// The code-mode setting a record and adapter options carry; omitted when unknown (records from before the setting).
const codeModeField = (codeMode) => (typeof codeMode === "boolean" ? { codeMode } : {});

function patternHandoff(reply) {
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
function view(s) {
  const r = s.record;
  return {
    session: r.address, harness: r.harness, project: r.project, nativeId: r.nativeId, workflowId: r.workflowId, cwd: r.cwd,
    place: r.place, status: r.status, permissionMode: r.permissionMode, ...(r.model ? { model: r.model } : {}), ...codeModeField(r.codeMode), run: r.run,
    ...(r.taskId ? { taskId: r.taskId } : {}), approvals: r.approvals.map(({ id, tool, summary }) => ({ id, tool, summary })), ...(r.cut ? { cut: r.cut } : {}),
  };
}

/** Creates the runner over project configs, a Map harness → Adapter and a durable log (runner/durable.mjs). */
export function createRunner({ projects, adapters, durable, env = process.env, git = runGit, now = Date.now, startGapMs = START_GAP_MS, approvalMs = approvalTimeoutMs(env), watch = true, log = () => {}, scheduleErrors = [], scheduleEntries = [], pumpMs = PUMP_MS, delivery = {} }) {
  const configs = new Map(projects.map((cfg) => [cfg.project, cfg]));
  const manualAt = new Map();
  const sessions = new Map();
  const claims = new Map();
  // The wake gate per closed session address: a wake runs after the previous wake of that session.
  const wakeTail = new Map();
  const watchers = new AbortController();
  const proc = selfProcess();
  let lastStartAt = 0;
  let pumpTimer = null;
  let lastPruneAt = -Infinity;
  // In-memory read positions of the pump's peeks, keyed by lane, state file and topic; see recordPeek in lib/inbox.mjs.
  const pumpPeeks = new Map();
  let pumping = false;
  let pumpSkipTicks = 0;
  let pumpLimitStreak = 0;

  const sessionCfg = (project, harness, label) => ({ ...configs.get(project), peer: harness, session: label });
  const adapterOf = (harness) => adapters.get(harness) || fail(400, `No ${harness} adapter is loaded`);
  const ownedEnv = () => childEnv(env);
  const find = (address) => sessions.get(address) || fail(404, "Unknown owned session");

  function save(s) {
    writeOwned(s.cfg, { ...s.record, ...(s.live?.resumeData ? { resume: s.live.resumeData() } : {}) });
  }

  // Serializes publishes per session so rows keep their order.
  function enqueuePublish(s, task) {
    s.publishing = s.publishing.then(task).catch(() => {});
    return s.publishing;
  }

  function onEvent(s, e) {
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
        s.patternReply = undefined;
        delete r.cut;
        save(s);
        break;
      case EventType.TEXT_MESSAGE_CHUNK:
        if (r.patternRun && e.role === "assistant") {
          const previous = s.patternReply?.id === e.messageId ? s.patternReply.text : "";
          s.patternReply = { id: e.messageId, text: (previous + (e.delta ?? "")).slice(-4096) };
        }
        break;
      case EventType.RUN_FINISHED:
      case EventType.RUN_ERROR:
        r.status = "idle";
        r.run = null;
        for (const card of [...r.approvals]) closeApproval(s, card.id, "cancelled");
        save(s);
        if (e.type === EventType.RUN_ERROR) s.finished.set(e.metadata.aiCollab.runId, { outcome: "error", message: e.message, ...(r.builder && limit?.wording ? { usageLimit: true } : {}) });
        else {
          const outcome = e.outcome?.type ?? "success";
          const handoff = outcome === "success" ? patternHandoff(s.patternReply?.text) : undefined;
          s.finished.set(e.runId, { outcome, ...(handoff ? { handoff } : {}) });
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
      const timer = setTimeout(() => respond(r.address, id, { decision: "deny" }).catch((error) => log(`approval timeout failed: ${error.message}`)), approvalMs);
      timer.unref();
      s.timers.set(id, timer);
      enqueuePublish(s, () => publishApproval(s.cfg, r.harness, { ...card, questions: request.questions }, approvalMs).catch((error) => log(`approval publish failed: ${error.message}`)));
      return;
    }
    if (e.type === EventType.CUSTOM && e.name === APPROVAL_RESOLVED) {
      const card = r.approvals.find((a) => a.interruptId === e.value.interruptId);
      if (card) closeApproval(s, card.id, e.value.reason);
      return;
    }
    // A harness limit (an adapter event or a run error): one limit card per session and window.
    if (limit) enqueuePublish(s, () => alertLimit(s.cfg, { harness: r.harness, limit }).catch((error) => log(`limit alert failed: ${error.message}`)));
    enqueuePublish(s, () => publishEvent(s.cfg, r.harness, e));
  }

  function closeApproval(s, id, reason) {
    if (!s.record.approvals.some((a) => a.id === id)) return;
    s.record.approvals = s.record.approvals.filter((a) => a.id !== id);
    s.pending.delete(id);
    clearTimeout(s.timers.get(id));
    s.timers.delete(id);
    save(s);
    enqueuePublish(s, () => publishApprovalEnd(s.cfg, id, reason).catch(() => {}));
  }

  // The adapter context; events wait for the holder's session, which exists once the session is claimed.
  function contextFor(holder, harness, signal) {
    return {
      signal,
      log: (message) => log(`${harness}: ${message}`),
      emit: (e) => (holder.s ? onEvent(holder.s, e) : log(`${harness}: event before claim dropped`)),
    };
  }

  // The in-memory session for a claimed record; built fresh on every workflow execution, replay included.
  function runtime(wf, record, holder) {
    let wakeAll = () => {};
    const s = {
      record, cfg: sessionCfg(record.project, record.harness, record.label), live: holder.live || null, pending: new Map(), timers: new Map(),
      publishing: Promise.resolve(), finished: new Map(), signal: wf.signal,
      wake: () => wakeAll(),
      changed: () => new Promise((resolve) => { wakeAll = resolve; }),
    };
    for (const card of record.approvals) s.pending.set(card.id, card);
    holder.s = s;
    sessions.set(record.address, s);
    return s;
  }

  // The live handle, resuming the native session for the next input when this execution has none (after a restart).
  async function liveHandle(s) {
    if (s.live) return s.live;
    if (s.record.status === "ended") fail(409, "The owned session has ended");
    if (s.record.builder) fail(409, "The builder sandbox session cannot resume");
    const adapter = adapterOf(s.record.harness);
    if (adapter.capabilities.resume === "none") fail(409, `${s.record.harness} sessions cannot resume`);
    s.resuming ??= (async () => {
      s.live = await adapter.resume(s.record, contextFor({ s }, s.record.harness, s.signal), ownedEnv());
      save(s);
      return s.live;
    })().finally(() => { s.resuming = null; });
    return s.resuming;
  }

  // Resolves when runId ends.
  async function waitRun(s, runId) {
    for (;;) {
      if (s.finished.has(runId)) return s.finished.get(runId);
      if (s.signal.aborted) throw s.signal.reason;
      await Promise.race([s.changed(), new Promise((_, reject) => s.signal.addEventListener("abort", () => reject(s.signal.reason), { once: true }))]);
    }
  }

  // Marks a run the runner can no longer finish as interrupted and closes its approvals; never resends.
  async function cutRun(s, runId, reason) {
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

  async function endSession(s, reason) {
    for (const card of [...s.record.approvals]) closeApproval(s, card.id, "cancelled");
    await s.live?.close().catch(() => {});
    s.live = null;
    s.record.status = "ended";
    s.record.run = null;
    save(s);
    await recordSession(s.cfg, { id: s.record.nativeId, cwd: s.record.cwd, harness: s.record.harness, event: "ended" }).catch(() => {});
    await enqueuePublish(s, () => publishEnded(s.cfg, s.record.harness, reason));
    return { ended: reason };
  }

  // The folder a session runs in: the project root, a fresh worktree, or (OpenShell) a worktree the sandbox syncs.
  async function placeCwd(project, harness, place, patternRun) {
    let root;
    try { root = projectRoot(project, env); } catch (error) { fail(400, error.message); }
    if (place === "folder") return root;
    const adapter = adapterOf(harness);
    if (!(adapter.capabilities.places ?? ["folder", "worktree"]).includes(place)) fail(400, `${harness} owned sessions cannot use place ${place} yet`);
    const tree = patternRun ? { name: "team-" + patternRun, branch: "team/" + patternRun } : worktreeNames(harness, now());
    const gitFile = findExecutable("git", childEnv(env).PATH);
    if (!gitFile) fail(500, "git is not installed");
    const cwd = join(root, ".claude", "worktrees", tree.name);
    if (patternRun && existsSync(join(cwd, ".git"))) return cwd;
    const code = await git(gitFile, ["-C", root, "worktree", "add", "-b", tree.branch, cwd], { cwd: root, env: childEnv(env) });
    if (code !== 0) fail(500, `git worktree add exited ${code}`);
    return cwd;
  }

  function checkOpenShellLaunch(harness, place, builder) {
    if (harness === "codex" && place === "openshell" && !builder) {
      fail(400, "Codex OpenShell starts require a tracked builder to prepare the launcher");
    }
  }

  // The durable session workflow: place → open → claim, then one run.send/run.wait pair per input until closed.
  async function sessionWorkflow(wf, input) {
    const { project, harness, place, permissionMode, model, codeMode, taskId, patternRun, builder } = input;
    checkOpenShellLaunch(harness, place, builder);
    const adapter = adapterOf(harness);
    const holder = { s: null, live: null };
    const staged = builder && await wf.step("builder.stage", async () => {
      try {
        return await stageOwnedBuilder(builder, env, log);
      } catch (error) {
        return { failed: error.message };
      }
    }, { onCut: () => ({ failed: "runner restarted while staging the builder" }) });
    if (staged?.failed) {
      await wf.step("builder.fail", () => finishOwnedBuilder(builder, null, 1, env, log, staged.failed));
      return { ended: staged.failed };
    }
    const cwd = await wf.step("place", () => builder ? builder.worktree : placeCwd(project, harness, place, patternRun));
    const opened = await wf.step("open", async () => {
      // An adapter that starts its child before returning (Claude) calls beforeStart with the native id: the owned record exists first.
      const beforeStart = (nativeId) => {
        const childLabel = sessionLabel(nativeId);
        writeOwned(sessionCfg(project, harness, childLabel), {
          v: 1, label: childLabel, address: `${harness}#${childLabel}`, workflowId: wf.id, harness, nativeId, project, cwd, place, permissionMode,
          ...(model ? { model } : {}), ...(patternRun ? { patternRun } : {}), ...codeModeField(codeMode), ...(taskId ? { taskId } : {}), status: "starting", run: null, approvals: [], createdAt: now(),
        });
      };
      const options = { project, cwd, place, permissionMode, permission: permissionSettings(harness, permissionMode, place).settings, env: ownedEnv(), beforeStart, ...(model ? { model } : {}), ...(patternRun ? { patternRun } : {}), ...codeModeField(codeMode) };
      try {
        holder.live = await adapter.open(staged ? { ...options, cwd: staged.workdir, sandboxArgv: staged.argv } : options, contextFor(holder, harness, wf.signal));
      } catch (error) {
        if (builder) return { failed: error.message };
        throw error;
      }
      return { nativeId: holder.live.nativeId };
    }, { onCut: () => ({ failed: "the runner stopped while the session opened" }) });
    if (opened.failed) {
      if (builder) await wf.step("builder.fail", () => finishOwnedBuilder(builder, staged, 1, env, log, opened.failed));
      return { ended: opened.failed };
    }
    const label = sessionLabel(opened.nativeId);
    const cfg = sessionCfg(project, harness, label);
    const claim = await wf.step("claim", async () => {
      const record = {
        v: 1, label, address: `${harness}#${label}`, workflowId: wf.id, harness, nativeId: opened.nativeId, project, cwd, place, permissionMode,
        ...(model ? { model } : {}), ...(patternRun ? { patternRun } : {}), ...codeModeField(codeMode), ...(taskId ? { taskId } : {}), status: "idle", run: null, approvals: [], createdAt: now(),
      };
      try {
        if (builder) {
          await claimOwnedBuilder(builder, record.address, env);
          record.builder = builder.id;
        }
        writeOwned(cfg, record);
      } catch (error) {
        if (builder) return { failed: error.message };
        throw error;
      }
      return null;
    });
    if (claim?.failed) {
      await holder.live?.close().catch(() => {});
      await wf.step("builder.fail", () => finishOwnedBuilder(builder, staged, 1, env, log, claim.failed));
      return { ended: claim.failed };
    }
    const s = runtime(wf, readOwned(cfg, label) || fail(500, "owned record missing"), holder);
    await recordSession(cfg, { id: opened.nativeId, cwd, harness, event: "owned", proc }).catch(() => {});
    if (!wf.replaying) await enqueuePublish(s, () => publishEvent(cfg, harness, { type: EventType.CUSTOM, name: NOTICE, value: `owned session started (${permissionMode})` }));
    claims.get(wf.id)?.(s);
    let next = { text: input.prompt, messageIds: [] };
    for (;;) {
      if (!next) {
        const batch = await wf.recv("input", { all: true });
        if (batch.some((i) => i.close)) break;
        next = merge(batch);
      }
      const turn = next;
      next = null;
      const sent = await wf.step("run.send", async () => {
        try {
          const handle = await liveHandle(s);
          while (s.switchingModel) await s.switchingModel.catch(() => {});
          s.record.status = "running";
          save(s);
          const { runId } = await handle.send(turn);
          publishReceipts(s.cfg, turn.messageIds);
          return { runId };
        } catch (error) {
          if (s.signal.aborted) throw error;
          s.record.status = "idle";
          save(s);
          await enqueuePublish(s, () => publishEvent(s.cfg, harness, { type: EventType.CUSTOM, name: ERROR, value: `input not delivered: ${error.message}` }));
          return { error: error.message };
        }
      }, { onCut: () => cutRun(s, null, "runner restarted before the harness accepted the input") });
      if (!sent.runId && !builder) continue;
      const finished = sent.runId && await wf.step("run.wait", () => waitRun(s, sent.runId), { onCut: () => cutRun(s, sent.runId, "runner restarted") });
      if (builder) {
        await wf.step("builder.finish", async () => {
          await s.live?.close().catch(() => {});
          s.live = null;
          await finishOwnedBuilder(builder, staged, finished?.outcome === "success" ? 0 : 1, env, log, undefined, finished?.usageLimit);
        });
        return wf.step("close", () => endSession(s, "builder finished"));
      }
      if (patternRun && finished?.handoff) {
        await wf.step("pattern.advance", async () => {
          try {
            await advancePattern({ project, id: patternRun, caller: s.record.address, ...finished.handoff });
          } catch (error) {
            await enqueuePublish(s, () => publishEvent(cfg, harness, { type: EventType.CUSTOM, name: ERROR, value: "handoff rejected: " + error.message }));
          }
          return null;
        }, { onCut: () => null });
      }
    }
    return wf.step("close", () => endSession(s, "closed by the operator"));
  }

  // A registry entry online in a process other than this runner: the user resumed the session outside the runner.
  const outsideOnline = (entry) => entry.online === true && entry.pid !== proc?.pid;
  const seenOutside = (cfg, address) => listSessions(cfg).some((e) => e.id === address && outsideOnline(e));

  // The owned record an adopted session gets from its registry entry: closed until the wake runs.
  function adoptedRecord(workflowId, project, label, a) {
    return {
      v: 1, label, address: `${a.harness}#${label}`, workflowId, harness: a.harness, nativeId: a.nativeId, project, cwd: a.cwd,
      place: "folder", permissionMode: defaultPermission(a.harness, "folder"), ...(a.model ? { model: a.model } : {}),
      status: "ended", run: null, approvals: [], createdAt: now(),
    };
  }

  // Starts a wake for messages to one closed session; messages that arrive while it runs join its queue instead.
  function startWake(project, address, messages, { adopt = null } = {}) {
    const id = `${WAKE}:${address}:${messages.at(-1).id}`;
    const run = durable.startWorkflowOnce(WAKE, id, { project, address, messages, ...(adopt ? { adopt } : {}) });
    if (run) run.catch(() => {});
    return run ? id : null;
  }

  // Wakes a closed session for its queued direct messages: one run takes every unseen message queued before it starts.
  // An adopted session (closed, not owned yet) gets its owned record from its registry entry first. Wakes of one address
  // run one after another; messages that arrive during a run take one more run, so one run covers each batch.
  async function wakeWorkflow(wf, input) {
    const { project, address, messages: first, adopt = null } = input;
    const [harness, label] = address.split("#");
    if (!adapters.has(harness)) return { status: "no-adapter", error: `no ${harness} adapter yet` };
    const previous = wakeTail.get(address);
    const gate = { id: wf.id, release: () => {}, done: null };
    gate.done = new Promise((resolve) => { gate.release = resolve; });
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
      const record = readOwned(cfg, label) || fail(500, `no owned record for ${address}`);
      const holder = { s: null, live: null };
      const s = runtime(wf, record, holder);
      for (let batch = first; ; ) {
        // Reserved under this workflow's id before the turn: the hooks and the waiter skip these messages.
        let got;
        for (let tries = 0; ; tries += 1) {
          got = await wf.step("wake.reserve", () => reserveOwned(scfg, batch.map((m) => m.id), { owner: wf.id }));
          if (!got.busy || tries >= 4) break;
          await wf.sleep(1000);
        }
        batch = batch.filter((m) => got.owned.includes(m.id)).map(m => reservedMessage(scfg, m)).filter(Boolean);
        if (!batch.length) break;
        const shown = await cacheAttachmentsWithin(scfg, batch, { budgetMs: ATTACHMENT_BUDGET_MS });
        const text = formatInbox(shown, { session: label });
        const messageIds = batch.map((m) => m.id);
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
            } catch (error) {
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
        const more = await wf.step("wake.more", () => durable.pendingCount(wf.id, WAKE_TOPIC) > 0);
        if (!more) break;
        batch = await wf.recv(WAKE_TOPIC, { all: true });
      }
      const result = await wf.step("wake.close", () => endSession(s, "closed again after a message"));
      finished = true;
      return result;
    } finally {
      gate.release();
      if (wakeTail.get(address) === gate) wakeTail.delete(address);
      // A finished wake hands any message that arrived after its last check to a new wake.
      if (finished) {
        const late = durable.drain(wf.id, WAKE_TOPIC);
        if (late.length) startWake(input.project, address, late, { adopt: input.adopt ?? null });
      }
    }
  }

  // Delivery to live sessions the runner does not own: the deps of runner/delivery.mjs, each overridable through `delivery`.
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
    scfgOf: (project, session) => ({ ...configs.get(project), peer: session.peer, session: session.session }),
    sessionOf: (project, address) => {
      const cfg = configs.get(project);
      return (cfg && listSessions(cfg).find((s) => s.id === address && s.online)) || null;
    },
    ready: async (session) => readySession(session, session.harness === "opencode" ? await openCodeActive() : null, { env, idle: sessionIdleState }),
    reserve: (scfg, ids, { owner, allowSeen = false }) => reserveOwned(scfg, ids, { owner, allowSeen, ttlMs: reserveTtlMs }),
    release: (scfg, ids, owner) => releaseOwned(scfg, ids, owner),
    markDelivered: (scfg, ids) => markDelivered(scfg, ids),
    snapshot: (session) => (session.harness === "claude" ? claudeSnapshot(session, { env }) : null),
    push: async (session, { text, urgent, ids }) => {
      const result = await pushSession(session, text, { urgent, ids }, { env });
      if (result.status === "unconfirmed") inflight.set(ids[0], result);
      return { status: result.status };
    },
    awaitConfirm: (id, session, snap) => {
      const result = inflight.get(id);
      inflight.delete(id);
      return result?.watch ? result.watch() : claudeConfirmedSince(snap, [id]);
    },
    // Polls the transcript for the whole confirm and watch window; Claude only, other harnesses never confirm.
    waitConfirmed: async (session, ids, snap) => {
      if (session.harness !== "claude") return false;
      const until = Date.now() + claudeWindowMs(env);
      for (;;) {
        if (claudeConfirmedSince(snap, ids)) return true;
        if (Date.now() >= until) return false;
        await delay(CONFIRM_POLL_MS);
      }
    },
    confirmedSince: (session, ids, snap) => (session.harness === "claude" ? claudeConfirmedSince(snap, ids) : false),
    acked: async (project, address, message) => {
      const topics = new Set([receiptsTopic(project), broadcastTopic(project), inboxTopic(project, address.split("#")[0])]);
      if (typeof message.from === "string" && message.from) topics.add(inboxTopic(project, message.from.split("#")[0]));
      await acks.refresh(configs.get(project), topics);
      return acks.acked(message.id, address);
    },
    reservedMessage,
    textFor: async (scfg, message, attemptNo) => {
      const shown = attemptNo > 1 ? { ...message, attempt: attemptNo, attempts: MAX_ATTEMPTS } : message;
      const [cached] = await cacheAttachmentsWithin(scfg, [shown], { budgetMs: ATTACHMENT_BUDGET_MS });
      return [identityLine(scfg), formatInbox([cached], { session: scfg.session })].filter(Boolean).join("\n");
    },
  };
  const deps = { ...deliveryDeps, ...delivery };
  durable.register(DELIVERY, deliveryWorkflow(deps));
  durable.register(WAKE, wakeWorkflow);

  // An expect-reply message the dispatcher delivered keeps its redelivery: its ledger entry becomes a delivery workflow.
  function migrateLedger(cfg, started) {
    const entries = readDispatchLedger(cfg);
    const left = { ...entries };
    for (const [msgId, e] of Object.entries(entries)) {
      if (!e || typeof e !== "object" || !e.message || typeof e.address !== "string") continue;
      const id = `${DELIVERY}:${e.address}:${msgId}`;
      const run = durable.startWorkflowOnce(DELIVERY, id, { project: cfg.project, address: e.address, message: e.message, redeliver: { pushes: e.attempts ?? 1, firstAt: e.firstAt } });
      if (run) { run.catch(() => {}); started.push(id); }
      if (run || durable.status(id)) delete left[msgId];
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

  async function pumpTick(limited) {
    const started = [];
    if (now() - lastPruneAt >= PRUNE_EVERY_MS) {
      lastPruneAt = now();
      durable.prune([DELIVERY, WAKE], now() - PRUNE_AFTER_MS);
    }
    let wakes = 0;
    // One poll per topic and read position per tick, shared by every session that reads it; a 429 skips its topic for the tick. One tick time keeps first reads on one position.
    const memo = { poll: new Map(), limited, now: now() };
    const live = { ...memo, peek: { cursors: pumpPeeks, lane: "live" } };
    const wake = { ...memo, peek: { cursors: pumpPeeks, lane: "wake" } };
    const known = new Set();
    for (const cfg of configs.values()) {
      if (!cfg.enabled) continue;
      migrateLedger(cfg, started);
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
          const fresh = (m) => !durable.status(`${DELIVERY}:${session.id}:${m.id}`);
          const messages = await deps.claim(scfg, { commit: false, limit: CLAIM_LIMIT, accept: (m) => direct(m) && fresh(m), ...live }).catch(() => []);
          for (const message of messages) {
            const id = `${DELIVERY}:${session.id}:${message.id}`;
            const run = durable.startWorkflowOnce(DELIVERY, id, { project: cfg.project, address: session.id, message });
            if (run) { run.catch(() => {}); started.push(id); }
          }
          continue;
        }
        // Only the exact session's messages wake it: a message to the peer as a whole never does.
        if (!PUSHED.has(session.harness) || session.seenAt < now() - SEEN_WITHIN_MS || wakes >= WAKES_PER_TICK || wakeTail.has(session.id)) continue;
        const messages = await deps.claim(scfg, { commit: false, limit: WAKE_BATCH, accept: (m) => direct(m) && m.to === session.id, ...wake }).catch(() => []);
        if (!messages.length) continue;
        const adopt = { nativeId: session.sessionId, cwd: session.cwd, ...(session.model ? { model: session.model } : {}) };
        const id = startWake(cfg.project, session.id, messages, { adopt });
        if (id) { started.push(id); wakes += 1; }
      }
    }
    // Read positions of sessions that are gone are dropped; a session that comes back re-reads from its committed cursor.
    for (const key of pumpPeeks.keys()) if (!known.has(key.split("\n")[1])) pumpPeeks.delete(key);
    return started;
  }

  /** Delivery and wake workflows, newest first, for the UI and the operator. */
  function deliveries() {
    const rows = [...durable.listNamed(DELIVERY, 100), ...durable.listNamed(WAKE, 100)].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100);
    return { deliveries: rows.map((r) => ({
      id: r.id, kind: r.name === WAKE ? "wake" : "delivery", status: r.status, address: r.input?.address ?? null,
      messageId: r.input?.message?.id ?? r.input?.messages?.at(-1)?.id ?? null, outcome: r.output?.status ?? null, error: r.error ?? null, updatedAt: r.updatedAt,
    })) };
  }

  durable.register("session", sessionWorkflow);

  /** Starts an owned session; resolves {status:"started", session, nativeId, workflowId, detail}. */
  async function start({ project, harness, prompt, model, place = "folder", permissionMode, codeMode, taskId, builder: builderId } = {}, patternRun) {
    if (!configs.has(project)) fail(400, "Unknown project");
    const adapter = adapterOf(harness);
    if (!PLACES.includes(place)) fail(400, "Unknown start place");
    // OpenShell is the boundary: every harness there runs with approvals off, whatever mode the caller named.
    const mode = place === "openshell" ? OPENSHELL_PERMISSION : permissionMode ?? defaultPermission(harness, place);
    if (!PERMISSION_MODES.includes(mode) || !adapter.capabilities.permissionModes.includes(mode)) fail(400, `${harness} does not support permission mode ${mode}`);
    const permission = permissionSettings(harness, mode, place);
    if (permission.error) fail(400, permission.error);
    const checked = checkPrompt(prompt);
    if (checked.error) fail(400, checked.error);
    if (model !== undefined && (typeof model !== "string" || !MODEL.test(model))) fail(400, "Invalid model name");
    if (codeMode !== undefined && parseCodeMode(codeMode) === undefined) fail(400, "codeMode must be on or off");
    if (taskId !== undefined) {
      if (typeof taskId !== "string" || !taskId) fail(400, "Invalid task id");
      if (!openTasks(project, env).list().some(task => task.id === taskId)) fail(400, "Unknown task in this project");
    }
    let builder;
    if (builderId !== undefined) {
      if (harness !== "codex" || place !== "openshell" || !taskId) fail(400, "A builder requires Codex, OpenShell and a task");
      try { builder = ownedBuilder(project, builderId, env); } catch (error) { fail(400, error.message); }
      if (builder.task !== taskId || builder.phase !== "starting") fail(409, "Builder already started or task mismatch");
    }
    checkOpenShellLaunch(harness, place, builder);
    if (!patternRun && !builder && now() - lastStartAt < startGapMs) fail(429, "Wait 10 seconds between starts");
    if (!patternRun && !builder) lastStartAt = now();
    const workflowId = `session-${randomUUID()}`;
    const claimed = new Promise((resolve) => claims.set(workflowId, resolve));
    const timer = new AbortController();
    const timeout = builder ? BUILDER_START_TIMEOUT_MS : START_TIMEOUT_MS;
    try {
      const run = durable.startWorkflow("session", workflowId, { project, harness, place, permissionMode: mode, prompt: checked.text, ...(builder ? { builder } : {}), ...(taskId ? { taskId } : {}), ...(model ? { model } : {}), ...(patternRun ? { patternRun } : {}), codeMode: resolveCodeMode(codeMode, env) });
      const ended = run.then((out) => fail(502, `${harness} session ended at once: ${out?.ended || "no reason"}`));
      ended.catch(() => {});
      const s = await Promise.race([
        claimed,
        ended,
        delay(timeout, null, { signal: timer.signal }).then(() => fail(504, `${harness} did not open within ${timeout / 1000} s`)),
      ]);
      return { status: "started", session: s.record.address, nativeId: s.record.nativeId, workflowId, ...(taskId ? { taskId } : {}), detail: `${harness} owned session started` };
    } catch (error) {
      if (error.status) throw error;
      throw Object.assign(new Error(`${harness} failed to start: ${error.message}`), { status: 502 });
    } finally {
      timer.abort();
      claims.delete(workflowId);
    }
  }

  const patternReplies = new Map();
  const patternWorkflowId = (project, id) => `pattern:${project}:${id}`;
  const patternConfig = (project) => {
    const cfg = configs.get(project);
    if (!cfg) fail(400, "Unknown project");
    return { ...cfg, peer: "operator", session: "" };
  };

  async function patternWorkflow(wf, { project, initial, request }) {
    const cfg = patternConfig(project);
    const launch = async (_cfg, { patternRun, ...options }) => {
      for (;;) {
        wf.signal.throwIfAborted();
        try {
          return await start({ ...options, project }, patternRun);
        } catch (error) {
          if (error.status !== 429) throw error;
          await wf.pause(Math.max(1, startGapMs - (now() - lastStartAt)));
        }
      }
    };
    let reply = await wf.step("pattern.entry", async () => {
      const started = await launchPatternRun(cfg, initial, env, launch);
      wf.signal.throwIfAborted();
      return started;
    }, {
      onCut: () => cutPatternRun(cfg, initial, "start"),
    });
    patternReplies.get(request)?.({ reply });
    while (reply.status === "running" || reply.status === "suspended") {
      const { request, event, options } = await wf.recv("advance");
      const outcome = await wf.step("pattern.advance", async () => {
        try {
          const advanced = await applyPatternAdvance(cfg, initial.id, event, {
            ...options, env, now, start: launch, notify: (address, text) => send(address, { text }),
          });
          wf.signal.throwIfAborted();
          return { reply: advanced };
        } catch (error) {
          wf.signal.throwIfAborted();
          return { error: error.message };
        }
      }, { onCut: () => ({ reply: cutPatternRun(cfg, initial, "advance") }) });
      patternReplies.get(request)?.(outcome);
      if (outcome.reply) reply = outcome.reply;
    }
    return reply;
  }

  durable.register("pattern", patternWorkflow);

  async function waitForPattern(id, request, submit) {
    const response = new Promise((resolve) => patternReplies.set(request, resolve));
    try {
      submit();
      const outcome = await Promise.race([
        response,
        durable.result(id).then((reply) => ({ error: reply ? `run ${reply.id} is ${reply.status}` : "Pattern runner stopped" })),
      ]);
      if (outcome.error) fail(409, outcome.error);
      return outcome.reply;
    } finally {
      patternReplies.delete(request);
    }
  }

  async function startPattern({ project, name, task } = {}) {
    const cfg = patternConfig(project);
    let initial;
    try {
      const pattern = getPattern(cfg, name, env);
      if (!pattern.file && pattern.source !== "built-in") throw new Error("A team.dot pattern is required");
      initial = { ...(await preparePatternRun(cfg, pattern, task, env, { now, openshell: true })), runner: true };
      for (const { harness } of initial.definition.roles) {
        checkOpenShellLaunch(harness, "openshell");
        if (!adapterOf(harness).capabilities.places?.includes("openshell")) throw new Error(harness + " does not support OpenShell team roles");
      }
    } catch (error) {
      fail(400, error.message);
    }
    if (now() - lastStartAt < startGapMs) fail(429, "Wait 10 seconds between starts");
    lastStartAt = now();
    const id = patternWorkflowId(project, initial.id);
    const request = randomUUID();
    return waitForPattern(id, request, () => durable.startWorkflow("pattern", id, { project, initial, request }));
  }

  async function advancePattern({ project, id, event, note, caller, override, confirmation, by } = {}) {
    const cfg = patternConfig(project);
    if (typeof id !== "string" || !RUN_ID.test(id)) fail(400, "Invalid pattern run id");
    const workflow = patternWorkflowId(project, id);
    const status = durable.status(workflow);
    if (!status) fail(404, "Unknown runner pattern");
    if (status.status !== "PENDING") fail(409, `run ${id} is ${runStatus(cfg, id).status}`);
    if (!(override === true && typeof confirmation === "string" && RUN_ID.test(confirmation))
        && (typeof event !== "string" || !event.trim() || event.trim().length > DOT_EVENT_MAX)) fail(400, "Invalid pattern event");
    const request = randomUUID();
    const options = {
      note: typeof note === "string" ? note.trim().slice(0, NOTE_MAX) : "",
      caller: typeof caller === "string" ? caller : "",
      override: override === true,
      confirmation: typeof confirmation === "string" ? confirmation : "",
      by: typeof by === "string" ? by.slice(0, 80) : "operator",
    };
    return waitForPattern(workflow, request, () => durable.send(workflow, "advance", { request, event, options }));
  }

  /** Queues input as a durable message, or steers the running run when asked and supported. */
  async function send(address, { text, steer = false, messageIds = [], dedupe = null } = {}) {
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
    const fresh = durable.send(s.record.workflowId, "input", { text, messageIds }, { dedupe });
    if (!fresh) return { status: "duplicate" };
    return { status: s.record.status === "running" ? "queued" : "sent" };
  }

  async function interrupt(address) {
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
  async function compact(address) {
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

  async function setModel(address, model) {
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

  /** Changes an owned session's permission mode; reached only through the control socket, never through ntfy or MCP. */
  async function setMode(address, mode) {
    const s = find(address);
    const r = s.record;
    if (r.status === "ended") fail(409, "The owned session has ended");
    if (r.place === "openshell" && mode !== OPENSHELL_PERMISSION) fail(400, "An OpenShell session always runs with full access");
    if (!PERMISSION_MODES.includes(mode) || !adapterOf(r.harness).capabilities.permissionModes.includes(mode)) fail(400, `${r.harness} does not support permission mode ${mode}`);
    const permission = permissionSettings(r.harness, mode, r.place);
    if (permission.error) fail(400, permission.error);
    const handle = await liveHandle(s);
    if (!handle.setPermissionMode) fail(409, `${r.harness} cannot change its permission mode while open`);
    await handle.setPermissionMode(mode);
    const was = r.permissionMode;
    r.permissionMode = mode;
    save(s);
    await enqueuePublish(s, () => publishEvent(s.cfg, r.harness, { type: EventType.CUSTOM, name: NOTICE, value: `permission mode ${was} → ${mode}` }));
    return { status: "changed", permissionMode: mode };
  }

  /** Answers an approval card: decision allow|deny, or answers for a choice. */
  async function respond(address, id, { decision, answers } = {}) {
    const s = find(address);
    const card = s.pending.get(id);
    if (!card) fail(404, "Unknown or closed approval");
    if (!s.live) {
      closeApproval(s, id, "cancelled");
      fail(409, "The run that asked was cut; the approval is closed");
    }
    const value = answers ? { behavior: "allow", answers } : decision === "allow" ? { behavior: "allow" } : decision === "deny" ? { behavior: "deny" } : null;
    if (!value) fail(400, "Decision must be allow or deny");
    // Closed first: the harness may finish the run before respond() resolves.
    closeApproval(s, id, answers ? "answered" : value.behavior === "allow" ? "allowed" : "denied");
    await s.live.respond(card.interruptId, value);
    return { status: "answered" };
  }

  /** Interrupts a running run, then ends the workflow; resolves once the session ended or CLOSE_WAIT_MS passed. */
  async function close(address) {
    const s = find(address);
    if (s.record.status === "ended") return { status: "ended" };
    if (s.record.status === "running") await s.live?.interrupt().catch(() => {});
    durable.send(s.record.workflowId, "input", { close: true });
    const timer = new AbortController();
    await Promise.race([durable.result(s.record.workflowId).catch(() => {}), delay(CLOSE_WAIT_MS, null, { signal: timer.signal }).catch(() => {})]);
    timer.abort();
    return { status: s.record.status === "ended" ? "ended" : "closing" };
  }

  /** Re-runs PENDING session workflows from the durable log (restart rules), then watches ntfy. */
  async function boot() {
    // Scheduled ticks recover too, but only session workflows hold the boot until they claim.
    const isSession = (id) => durable.status(id)?.name === "session";
    const sessionIds = durable.pending().filter(isSession);
    const claimed = sessionIds.map((id) => new Promise((resolve) => claims.set(id, resolve)));
    const ids = durable.recover();
    const waits = sessionIds.map((id, i) => Promise.race([claimed[i], durable.result(id).catch(() => {})]));
    const timer = new AbortController();
    await Promise.race([Promise.all(waits), delay(START_TIMEOUT_MS, null, { signal: timer.signal }).catch(() => {})]);
    timer.abort();
    for (const id of sessionIds) claims.delete(id);
    if (watch) for (const cfg of configs.values()) watchProject(cfg);
    if (watch && pumpMs > 0) {
      pumpTimer = setInterval(() => pumpDeliveries().catch((error) => log(`delivery pump failed: ${error.message}`)), pumpMs);
      pumpTimer.unref();
    }
    return ids.filter(isSession);
  }

  /** Runs a schedule's tick now; fails 404 for an unknown schedule and 429 within MANUAL_RUN_GAP_MS of the last one. */
  function runSchedule(name, caller = "unknown") {
    if (!durable.hasSchedule(name)) fail(404, "Unknown schedule");
    const at = now();
    if (at - (manualAt.get(name) ?? -Infinity) < MANUAL_RUN_GAP_MS) fail(429, `Wait ${MANUAL_RUN_GAP_MS / 1000} seconds between manual runs`);
    manualAt.set(name, at);
    const result = durable.runScheduled(name);
    log(`manual run of ${name} as ${result.id} (${result.status}) by ${caller}`);
    return result;
  }

  // An ntfy event: a phone reply to an owned approval, or a message for an owned session.
  async function onNtfy(cfg, topic, ev) {
    const reply = parsePhoneReply(ev.message || "");
    if (reply && topic === broadcastTopic(cfg.project)) {
      if (!APPROVAL_ID.test(reply.id)) return;
      for (const s of sessions.values()) {
        const card = s.pending.get(reply.id);
        const decision = card ? replyDecision(card, reply.answer) : null;
        if (decision) await respond(s.record.address, reply.id, decision.answers ? { answers: decision.answers } : { decision: decision.behavior }).catch((error) => log(`reply failed: ${error.message}`));
      }
      return;
    }
    const broadcast = topic === broadcastTopic(cfg.project);
    const m = parseEnvelope(ev.message || "");
    if (!m && broadcast) return deliverPlain(cfg, ev);
    if (m?.kind !== "msg" || typeof m.body !== "string" || !isValidName(m.from)) return;
    const sender = typeof m.session === "string" && SESSION_LABEL.test(m.session) ? m.session : "";
    const attachment = attachmentOf(ev);
    const item = (s) => ({
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
      // A project-chat broadcast reaches every owned session of the project, except a start-only post.
      if (m.from === "operator" && m.startOnly === true) return;
      for (const s of sessions.values()) await deliver(cfg, s, item(s), m.urgent === true, m.from, sender);
    }
  }

  // Raw text the operator typed in the project chat (not a phone reply, not a question) reaches every owned session.
  async function deliverPlain(cfg, ev) {
    const text = (ev.message || "").trim();
    if (!text || parseQuestionText(text)) return;
    for (const s of sessions.values()) {
      await deliver(cfg, s, { id: ev.id, from: "ntfy", to: "all", ts: "", body: text.slice(0, TEXT_MAX), operatorBroadcast: true }, false, "ntfy", "");
    }
  }

  // A direct message to a closed owned session wakes it. While a wake runs, the message joins that wake's queue.
  // A session seen online outside the runner is left to the hooks and live delivery.
  function wake(cfg, s, message) {
    const address = s.record.address;
    if (seenOutside(cfg, address)) return;
    const inflight = wakeTail.get(address);
    if (inflight) {
      durable.send(inflight.id, WAKE_TOPIC, message, { dedupe: `ntfy:${message.id}` });
      return;
    }
    startWake(cfg.project, address, [message]);
  }

  // Queues one inbox item as the session's next input; skips other projects and the session's own messages.
  async function deliver(cfg, s, message, urgent, from, sender, isDirect = false) {
    if (s.record.project !== cfg.project) return;
    if (from === s.record.harness && (!sender || sender === s.record.label)) return;
    if (s.record.status === "ended" || wakeTail.has(s.record.address)) {
      if (isDirect && !s.record.builder) wake(cfg, s, message);
      return;
    }
    // A live session gets the message only after any attachment is in the shared cache, so it reads the file
    // rather than downloading it again.
    const [cached] = await cacheAttachmentsWithin({ ...cfg, peer: s.record.harness, session: s.record.label }, [message], { budgetMs: ATTACHMENT_BUDGET_MS });
    const text = formatInbox([cached], { session: s.record.label });
    await send(s.record.address, { text, steer: urgent, messageIds: [message.id], dedupe: `ntfy:${message.id}:${s.record.label}` }).catch((error) => log(`delivery failed: ${error.message}`));
  }

  // Streams the broadcast topic and each loaded harness's inbox from the stored cursor, reconnecting with backoff.
  async function watchProject(cfg) {
    const topics = [broadcastTopic(cfg.project), ...[...adapters.keys()].map((h) => inboxTopic(cfg.project, h))];
    const key = `ntfy-cursor:${cfg.project}`;
    let since = durable.getKv(key) || String(Math.floor(now() / 1000));
    let backoff = 1000;
    while (!watchers.signal.aborted) {
      try {
        for await (const ev of streamEvents(cfg, topics, { since, signal: watchers.signal, onOpen: () => { backoff = 1000; } })) {
          await onNtfy(cfg, ev.topic, ev);
          since = ev.id;
          durable.setKv(key, since);
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
    return Promise.all([...adapters.values()].map(async (a) => ({ harness: a.harness, capabilities: a.capabilities, ...(await a.available(env).catch((e) => ({ ok: false, detail: e.message }))) })));
  }

  const entryOf = (name) => {
    const entry = scheduleEntries.find((item) => item.name === name);
    if (!entry) return {};
    const session = sessionOfCommand(entry.command);
    return { command: entry.command, cwd: entry.cwd, ...(session ? { session } : {}) };
  };

  return {
    start, startPattern, advancePattern, send, interrupt, compact, respond, setModel, setMode, close, boot, stop, harnesses, deliveries, pump: pumpDeliveries,
    list: () => [...sessions.values()].map(view),
    // Each schedule with the command and folder its schedules.json entry names, and the session it resumes.
    schedules: () => ({ schedules: durable.schedules().map((s) => ({ ...s, ...entryOf(s.name) })), configError: scheduleErrors }),
    // One schedule's ticks, each with the session its command resumes so the UI can open that run's timeline.
    scheduleRuns: (name) => {
      const session = sessionOfCommand(scheduleEntries.find((item) => item.name === name)?.command);
      return durable.scheduleRuns(name).map((run) => (session ? { ...run, session } : run));
    },
    runSchedule,
    get: (address) => view(find(address)),
    models: (harness) => adapterOf(harness).listModels(env),
    commands: (harness, project) => {
      if (!configs.has(project)) fail(400, "Unknown project");
      return adapterOf(harness).listCommands(projectRoot(project, env), env);
    },
    context: async (address) => (await (await liveHandle(find(address))).contextUsage?.()) ?? null,
    settle: () => Promise.all([...sessions.values()].map((s) => s.publishing)),
  };
}
