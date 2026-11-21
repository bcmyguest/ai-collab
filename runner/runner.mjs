// Runner core: one durable "session" workflow per owned session; control calls and ntfy input become durable messages.
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SESSION_LABEL, broadcastTopic, inboxTopic, isValidName, sessionLabel } from "../lib/config.mjs";
import { parseEnvelope } from "../lib/inbox.mjs";
import { parsePhoneReply, parseQuestionText } from "../lib/questions.mjs";
import { replyDecision, APPROVAL_ID } from "../lib/approvals.mjs";
import { formatInbox } from "../lib/format.mjs";
import { streamEvents } from "../lib/ntfy.mjs";
import { recordSession } from "../lib/sessions.mjs";
import { childEnv, checkPrompt, findExecutable, projectRoot, worktreeNames } from "../lib/start.mjs";
import { readOwned, writeOwned } from "../lib/owned.mjs";
import { PERMISSION_MODES, PLACES, approvalTimeoutMs, defaultPermission, eventProblem, permissionSettings } from "./contract.mjs";
import { publishApproval, publishApprovalEnd, publishEnded, publishEvent, publishReceipts } from "./publish.mjs";

export const START_TIMEOUT_MS = 60_000;
export const START_GAP_MS = 10_000;
export const CLOSE_WAIT_MS = 10_000;
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

/** Public view of a session for the control API. */
function view(s) {
  const r = s.record;
  return {
    session: r.address, harness: r.harness, project: r.project, nativeId: r.nativeId, workflowId: r.workflowId, cwd: r.cwd,
    place: r.place, status: r.status, permissionMode: r.permissionMode, ...(r.model ? { model: r.model } : {}), run: r.run,
    approvals: r.approvals.map(({ id, tool, summary }) => ({ id, tool, summary })), ...(r.cut ? { cut: r.cut } : {}),
  };
}

/** Creates the runner over project configs, a Map harness → Adapter and a durable log (runner/durable.mjs). */
export function createRunner({ projects, adapters, durable, env = process.env, git = runGit, now = Date.now, startGapMs = START_GAP_MS, approvalMs = approvalTimeoutMs(env), watch = true, log = () => {} }) {
  const configs = new Map(projects.map((cfg) => [cfg.project, cfg]));
  const sessions = new Map();
  const claims = new Map();
  const watchers = new AbortController();
  const proc = selfProcess();
  let lastStartAt = 0;

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
    switch (e.type) {
      case "RUN_STARTED":
        r.status = "running";
        r.run = { id: e.runId, startedAt: now() };
        delete r.cut;
        save(s);
        break;
      case "RUN_FINISHED":
      case "RUN_ERROR":
        r.status = "idle";
        r.run = null;
        for (const card of [...r.approvals]) closeApproval(s, card.id, "cancelled");
        save(s);
        s.finished.set(e.runId, e.type === "RUN_ERROR" ? { outcome: "error", message: e.message } : { outcome: e.outcome });
        s.wake();
        break;
      case "INTERRUPT_REQUESTED": {
        const id = randomBytes(6).toString("hex");
        const card = { id, interruptId: e.interruptId, tool: e.toolCallName, summary: e.summary };
        r.approvals.push(card);
        s.pending.set(id, { ...card, questions: e.questions });
        save(s);
        // An unanswered card is denied after approvalMs.
        const timer = setTimeout(() => respond(r.address, id, { decision: "deny" }).catch((error) => log(`approval timeout failed: ${error.message}`)), approvalMs);
        timer.unref();
        s.timers.set(id, timer);
        enqueuePublish(s, () => publishApproval(s.cfg, r.harness, { ...card, questions: e.questions }, approvalMs).catch((error) => log(`approval publish failed: ${error.message}`)));
        return;
      }
      case "INTERRUPT_RESOLVED": {
        const card = r.approvals.find((a) => a.interruptId === e.interruptId);
        if (card) closeApproval(s, card.id, e.reason);
        return;
      }
    }
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
    const adapter = adapterOf(s.record.harness);
    if (adapter.capabilities.resume === "none") fail(409, `${s.record.harness} sessions cannot resume`);
    s.live = await adapter.resume(s.record, contextFor({ s }, s.record.harness, s.signal), ownedEnv());
    save(s);
    return s.live;
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
    await enqueuePublish(s, () => publishEvent(s.cfg, r.harness, { type: "RUN_FINISHED", runId: runId || "unsent", outcome: "cancelled", reason }));
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

  async function placeCwd(project, harness, place) {
    let root;
    try { root = projectRoot(project, env); } catch (error) { fail(400, error.message); }
    if (place === "folder") return root;
    if (place === "openshell") fail(400, "openshell owned sessions are not supported yet");
    const tree = worktreeNames(harness, now());
    const gitFile = findExecutable("git", childEnv(env).PATH);
    if (!gitFile) fail(500, "git is not installed");
    const cwd = join(root, ".claude", "worktrees", tree.name);
    const code = await git(gitFile, ["-C", root, "worktree", "add", "-b", tree.branch, cwd], { cwd: root, env: childEnv(env) });
    if (code !== 0) fail(500, `git worktree add exited ${code}`);
    return cwd;
  }

  // The durable session workflow: place → open → claim, then one run.send/run.wait pair per input until closed.
  async function sessionWorkflow(wf, input) {
    const { project, harness, place, permissionMode, model } = input;
    const adapter = adapterOf(harness);
    const holder = { s: null, live: null };
    const cwd = await wf.step("place", () => placeCwd(project, harness, place));
    const opened = await wf.step("open", async () => {
      const options = { project, cwd, place, permissionMode, permission: permissionSettings(harness, permissionMode, place).settings, env: ownedEnv(), ...(model ? { model } : {}) };
      holder.live = await adapter.open(options, contextFor(holder, harness, wf.signal));
      return { nativeId: holder.live.nativeId };
    }, { onCut: () => ({ failed: "the runner stopped while the session opened" }) });
    if (opened.failed) return { ended: opened.failed };
    const label = sessionLabel(opened.nativeId);
    const cfg = sessionCfg(project, harness, label);
    await wf.step("claim", async () => {
      const record = {
        v: 1, label, address: `${harness}#${label}`, workflowId: wf.id, harness, nativeId: opened.nativeId, project, cwd, place, permissionMode,
        ...(model ? { model } : {}), status: "idle", run: null, approvals: [], createdAt: now(),
      };
      writeOwned(cfg, record);
      return null;
    });
    const s = runtime(wf, readOwned(cfg, label) || fail(500, "owned record missing"), holder);
    await recordSession(cfg, { id: opened.nativeId, cwd, harness, event: "owned", proc }).catch(() => {});
    if (!wf.replaying) await enqueuePublish(s, () => publishEvent(cfg, harness, { type: "CUSTOM", name: "notice", value: `owned session started (${permissionMode})` }));
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
          s.record.status = "running";
          save(s);
          const { runId } = await handle.send(turn);
          publishReceipts(s.cfg, turn.messageIds);
          return { runId };
        } catch (error) {
          if (s.signal.aborted) throw error;
          s.record.status = "idle";
          save(s);
          await enqueuePublish(s, () => publishEvent(s.cfg, harness, { type: "CUSTOM", name: "error", value: `input not delivered: ${error.message}` }));
          return { error: error.message };
        }
      }, { onCut: () => cutRun(s, null, "runner restarted before the harness accepted the input") });
      if (!sent.runId) continue;
      await wf.step("run.wait", () => waitRun(s, sent.runId), { onCut: () => cutRun(s, sent.runId, "runner restarted") });
    }
    return wf.step("close", () => endSession(s, "closed by the operator"));
  }

  durable.register("session", sessionWorkflow);

  /** Starts an owned session; resolves {status:"started", session, nativeId, workflowId, detail}. */
  async function start({ project, harness, prompt, model, place = "folder", permissionMode } = {}) {
    if (!configs.has(project)) fail(400, "Unknown project");
    const adapter = adapterOf(harness);
    if (!PLACES.includes(place)) fail(400, "Unknown start place");
    const mode = permissionMode ?? defaultPermission(harness, place);
    if (!PERMISSION_MODES.includes(mode) || !adapter.capabilities.permissionModes.includes(mode)) fail(400, `${harness} does not support permission mode ${mode}`);
    const permission = permissionSettings(harness, mode, place);
    if (permission.error) fail(400, permission.error);
    const checked = checkPrompt(prompt);
    if (checked.error) fail(400, checked.error);
    if (model !== undefined && (typeof model !== "string" || !MODEL.test(model))) fail(400, "Invalid model name");
    if (now() - lastStartAt < startGapMs) fail(429, "Wait 10 seconds between starts");
    lastStartAt = now();
    const workflowId = `session-${randomUUID()}`;
    const claimed = new Promise((resolve) => claims.set(workflowId, resolve));
    const timer = new AbortController();
    try {
      const run = durable.startWorkflow("session", workflowId, { project, harness, place, permissionMode: mode, prompt: checked.text, ...(model ? { model } : {}) });
      const ended = run.then((out) => fail(502, `${harness} session ended at once: ${out?.ended || "no reason"}`));
      ended.catch(() => {});
      const s = await Promise.race([
        claimed,
        ended,
        delay(START_TIMEOUT_MS, null, { signal: timer.signal }).then(() => fail(504, `${harness} did not open within ${START_TIMEOUT_MS / 1000} s`)),
      ]);
      return { status: "started", session: s.record.address, nativeId: s.record.nativeId, workflowId, detail: `${harness} owned session started` };
    } catch (error) {
      if (error.status) throw error;
      throw Object.assign(new Error(`${harness} failed to start: ${error.message}`), { status: 502 });
    } finally {
      timer.abort();
      claims.delete(workflowId);
    }
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

  /** Changes an owned session's permission mode; reached only through the control socket, never through ntfy or MCP. */
  async function setMode(address, mode) {
    const s = find(address);
    const r = s.record;
    if (r.status === "ended") fail(409, "The owned session has ended");
    if (!PERMISSION_MODES.includes(mode) || !adapterOf(r.harness).capabilities.permissionModes.includes(mode)) fail(400, `${r.harness} does not support permission mode ${mode}`);
    const permission = permissionSettings(r.harness, mode, r.place);
    if (permission.error) fail(400, permission.error);
    const handle = await liveHandle(s);
    if (!handle.setPermissionMode) fail(409, `${r.harness} cannot change its permission mode while open`);
    await handle.setPermissionMode(mode);
    const was = r.permissionMode;
    r.permissionMode = mode;
    save(s);
    await enqueuePublish(s, () => publishEvent(s.cfg, r.harness, { type: "CUSTOM", name: "notice", value: `permission mode ${was} → ${mode}` }));
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
    return ids.filter(isSession);
  }

  /** Runs a schedule's tick now; fails 404 for an unknown schedule. */
  function runSchedule(name) {
    if (!durable.hasSchedule(name)) fail(404, "Unknown schedule");
    return durable.runScheduled(name);
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
    const item = (s) => ({
      id: ev.id, from: sender ? `${m.from}#${sender}` : m.from, to: s.record.address, ts: typeof m.ts === "string" ? m.ts : "", body: m.body,
      ...(m.operatorThread === true && m.from === "operator" ? { operatorThread: true } : {}),
      ...(m.from === "operator" && broadcast ? { operatorBroadcast: true } : {}),
      ...(m.urgent === true ? { urgent: true } : {}),
      ...(m.from === "operator" && typeof m.mentionedIn === "string" ? { mentionedIn: m.mentionedIn } : {}),
    });
    if (typeof m.toSession === "string") {
      // A direct message or @mention for one owned session.
      if (!SESSION_LABEL.test(m.toSession)) return;
      const s = sessions.get(`${m.to}#${m.toSession}`);
      if (s) await deliver(cfg, s, item(s), m.urgent === true, m.from, sender);
    } else if (broadcast && m.to === "all") {
      // A project-chat broadcast reaches every owned session of the project.
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

  // Queues one inbox item as the session's next input; skips other projects, ended sessions and the session's own messages.
  async function deliver(cfg, s, message, urgent, from, sender) {
    if (s.record.project !== cfg.project || s.record.status === "ended") return;
    if (from === s.record.harness && (!sender || sender === s.record.label)) return;
    const text = formatInbox([message], { session: s.record.label });
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

  return {
    start, send, interrupt, respond, setMode, close, boot, stop, harnesses,
    list: () => [...sessions.values()].map(view),
    schedules: () => durable.schedules(),
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
