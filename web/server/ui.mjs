import { publishMode as publishModeAll } from "../../lib/mode.mjs";
import { mkdirSync, watch } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { loadConfig, loadProjects, activityTopic, broadcastTopic, configDir, inboxTopic, receiptsTopic, statusTopic, SESSION_LABEL, isGithubLogin, isValidName } from "../../lib/config.mjs";
import { ACTIVITY_TYPES } from "../../lib/activity.mjs";
import { stripControl } from "../../lib/format.mjs";
import { NTFY_MESSAGE_MAX_BYTES, latestStatuses, markUrgent, parseEnvelope, sendMessage } from "../../lib/inbox.mjs";
import { publish } from "../../lib/ntfy.mjs";
import { parsePhoneReply } from "../../lib/questions.mjs";
import { listSessions } from "../../lib/sessions.mjs";
import { readReceipts } from "../../lib/receipts.mjs";
import { controlSession } from "../../lib/controls.mjs";
import { APPROVAL_ID, END_REASONS, cleanQuestions, parseChoice, replyDecision } from "../../lib/approvals.mjs";
import { availableHarnesses, availablePlaces, checkPrompt, startSession } from "../../lib/start.mjs";
import { cleanName } from "../../lib/names.mjs";
import { listModels } from "../../lib/models.mjs";
import { activityRows, groupSubagents, summarize } from "../lib/activity-rows.js";
import { fallbackName, visibleWake } from "../lib/session-state.js";
import { createAuth } from "./auth.mjs";
import { createHub } from "./hub.mjs";
import { createPush, notice } from "./push.mjs";

const INSTANCE = Symbol.for("ai-collab.ui");
const ACTIONS = ["messages", "send", "reply", "nudge", "compact", "wake", "afk", "approve", "start", "models"];
const START_GAP_MS = 10_000;
const REFRESH_MS = 10_000;
const PARENT = /^[a-z0-9-]{1,24}#[a-f0-9]{16}$/;
const STARTABLE_CACHE_MS = 60_000;
const ANSWER_MAX_CHARS = 2000;
const MODES = ["on", "off", "quiet"];
const MAX_REQUEST_BYTES = 32768;
const ONLINE_MS = 30 * 60_000;
const KEEPALIVE_MS = 25_000;
const PUSH_DELAY_MS = 25;
const questionPattern = /^Question from ([^\n]+)\n\n([\s\S]+)\n\nReply in this topic: reply ([a-f0-9]{12}) YOUR ANSWER$/;
const MAX_MESSAGES = 100;
const IMPORTANT = /^IMPORTANT, the agent waits for this answer: /;
// The hub keeps the newest 500 events per topic; 3 MB of cached history covers 500 full 4 KB activity envelopes.
const ACTIVITY_TAIL_BYTES = 3 * 1024 * 1024;
const ACTIVITY_TEXT_MAX = 8192;
const ACTIVITY_NAME_MAX = 128;
const RECIPIENTS_MAX = 5000;
// Notify only for items this recent that still wait on the operator; older history was seen or has closed.
const NOTIFY_RECENT_MS = 15 * 60_000;
const NOTIFY_RETRY_MS = 30_000;
const IMPORTANT_PREFIX = "IMPORTANT, the agent waits for this answer: ";
const PUSH_ACTIONS = ["key", "subscribe", "test"];
// A question or approval reply the UI sent for a signed-in user names them in its ntfy title.
const REPLY_TITLE = /^Reply from operator \(([^)]+)\)$/;
const encoder = new TextEncoder();

const peerOf = address => String(address || "").split("#")[0];
const replyTitle = (cfg, by) => "Reply from " + cfg.peer + (by ? ` (${by})` : "");
const replyBy = event => { const by = REPLY_TITLE.exec(event.title || "")?.[1]; return isGithubLogin(by) ? by : undefined; };

// Operator AFK mode for every project's agents, by the signed-in user if any; throws when any project's publish fails.
export async function publishMode(cfgs, mode, by) {
  const failed = (await publishModeAll(cfgs, mode, by ? { by } : {})).filter(r => !r.ok);
  if (failed.length) throw new Error(`Mode publish failed for ${failed.map(r => r.project).join(", ")}`);
}

// Latest operator mode envelope in the given events; none means off.
function latestMode(events) {
  let latest = { mode: "off", at: 0 };
  for (const event of events) {
    const envelope = parseEnvelope(event.message);
    if (envelope?.kind !== "mode" || envelope.from !== "operator" || !MODES.includes(envelope.mode)) continue;
    const at = Number(envelope.ts) || event.time * 1000;
    if (at >= latest.at) latest = { mode: envelope.mode, at };
  }
  return latest;
}

const FILE_NAME = /^[A-Za-z0-9]{1,32}\.(?:png|jpe?g|gif|webp)$/;
const TEXT_FILE_NAME = /^[A-Za-z0-9]{1,32}\.txt$/;
const TEXT_TYPE = /^text\/plain(?:;|$)/;
const activityCache = new WeakMap();

// ntfy attachment metadata, exposed by file name only; the UI fetches it through /api/file/<file>.
// Chat topics carry images only; text/plain is accepted only on the activity topic (text = true).
function attachmentOf(event, { text = false } = {}) {
  const a = event.attachment;
  const file = typeof a?.url === "string" ? a.url.slice(a.url.lastIndexOf("/") + 1) : "";
  const ok = text ? TEXT_FILE_NAME.test(file) && TEXT_TYPE.test(a.type || "") : FILE_NAME.test(file) && /^image\//.test(a.type || "");
  if (!ok) return undefined;
  return { file, name: String(a.name || file).slice(0, 200), type: a.type, size: Number(a.size) || 0 };
}

const cleanText = (value, max) => typeof value === "string" && value ? stripControl(value).slice(0, max) : undefined;

// One activity row per valid activity envelope; anything else on the topic is dropped. Cached per event object.
function activityItem(event) {
  if (activityCache.has(event)) return activityCache.get(event);
  const e = parseEnvelope(event.message);
  let item = null;
  if (e?.kind === "activity" && isValidName(e.from) && typeof e.session === "string" && SESSION_LABEL.test(e.session) && ACTIVITY_TYPES.includes(e.type)) {
    item = { id: event.id, time: event.time, agent: e.from + "#" + e.session, harness: cleanText(e.harness, 10) || "other", type: e.type };
    for (const [key, max] of [["tool", ACTIVITY_NAME_MAX], ["callId", ACTIVITY_NAME_MAX], ["input", ACTIVITY_TEXT_MAX], ["output", ACTIVITY_TEXT_MAX]]) {
      const value = cleanText(e[key], max);
      if (value) item[key] = value;
    }
    const attachment = attachmentOf(event, { text: true });
    if (attachment) item.attachment = attachment;
    // A subagent's rows carry its run; the envelope's agent becomes subagent because agent already names the session.
    const run = cleanText(e.agent?.id, ACTIVITY_NAME_MAX);
    if (run) item.subagent = { id: run, type: cleanText(e.agent.type, ACTIVITY_NAME_MAX) || "" };
  }
  activityCache.set(event, item);
  return item;
}

// One chat entry per ntfy event; status and alert envelopes are skipped.
function entry(event) {
  const item = baseEntry(event);
  const attachment = item && attachmentOf(event);
  return attachment ? { ...item, attachment } : item;
}

function baseEntry(event) {
  const { message, id, time } = event;
  const envelope = parseEnvelope(message);
  if (envelope) {
    if (envelope.kind === "approval") return approvalEntry(event, envelope);
    if (envelope.kind !== "msg" || typeof envelope.body !== "string") return null;
    const sender = envelope.session ? `${envelope.from}#${envelope.session}` : envelope.from;
    const to = envelope.toSession ? `${envelope.to}#${envelope.toSession}` : envelope.to;
    const by = envelope.from === "operator" && isGithubLogin(envelope.by) ? { by: envelope.by } : {};
    return { id, time, kind: "Message", sender, from: sender, to, body: envelope.body, thread: envelope.operatorThread === true, ...(envelope.urgent === true ? { urgent: true } : {}), ...by };
  }
  const question = questionPattern.exec(message);
  if (question) return { id, time, kind: "Question", sender: question[1], from: question[1], body: question[2], question: question[3] };
  const reply = parsePhoneReply(message);
  const by = replyBy(event);
  if (reply) return { id, time, kind: "Reply", sender: "ntfy", from: "ntfy", body: reply.answer, question: reply.id, ...(by ? { by } : {}) };
  return { id, time, kind: "Message", sender: "ntfy", from: "ntfy", body: message };
}

// A permission request or AskUserQuestion choice a hook is waiting on; its state comes from replies and its end envelope.
function approvalEntry({ id, time }, e) {
  if (!isValidName(e.from) || !APPROVAL_ID.test(e.id) || (e.session !== undefined && !SESSION_LABEL.test(e.session))) return null;
  const sender = e.session ? `${e.from}#${e.session}` : e.from;
  const questions = e.questions === undefined ? undefined : cleanQuestions(e.questions);
  if (questions === null) return null;
  const approval = {
    id: e.id, harness: cleanText(e.harness, 10) || "other", tool: cleanText(e.tool, ACTIVITY_NAME_MAX) || "tool",
    summary: cleanText(e.summary, 300) || "", expiresAt: Number.isSafeInteger(e.expiresAt) ? e.expiresAt : 0,
    ...(questions ? { questions } : {}),
  };
  return { id, time, kind: "Approval", sender, from: sender, body: approval.summary, approval };
}

// Outcome of each approval and the answers to each question (with who sent them), from the broadcast topic's replies and end envelopes.
function outcomes(events) {
  const ends = new Map();
  const replies = new Map();
  const senders = new Map();
  for (const event of events) {
    const reply = parsePhoneReply(event.message);
    if (reply) {
      if (!replies.has(reply.id)) { replies.set(reply.id, []); senders.set(reply.id, []); }
      replies.get(reply.id).push(reply.answer);
      senders.get(reply.id).push(replyBy(event));
      continue;
    }
    const e = parseEnvelope(event.message);
    if (e?.kind === "approval-end" && APPROVAL_ID.test(e.id) && END_REASONS.includes(e.reason) && !ends.has(e.id)) ends.set(e.id, e.reason);
  }
  return { ends, replies, senders };
}

const MENTION = /(^|[^\w#-])@([a-z0-9-]{1,24}(?:#[a-f0-9]{16}|:[A-Za-z0-9][A-Za-z0-9._/-]{0,119})?)(?![\w-])/g;

/** Session addresses, harness names and harness:model pairs tagged with @ in a post, limited to the project's peers. */
export function mentionedNames(body, peers = []) {
  // A full stop after @harness:model ends the sentence, not the model name.
  const names = new Set([...String(body).matchAll(MENTION)].map(match => match[2].replace(/\.+$/, "")));
  return [...names].filter(name => {
    const peer = name.split(/[#:]/)[0];
    return peer !== "operator" && peer !== "all" && (!peers.length || peers.includes(peer));
  });
}

const mentions = (body, name) => new RegExp(`(^|[^\\w#-])@${name}(?![\\w-])`).test(body);

function reject(status, message) {
  throw Object.assign(new Error(message), { status });
}

function json(status, value) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

function failure(err) {
  const status = err.status || ([401, 403].includes(err.ntfyStatus) ? 403 : err.ntfyStatus === 429 ? 429 : 502);
  const message = err.status ? err.message : status === 403 ? "The ntfy account cannot access that channel"
    : status === 429 ? "The messaging service is rate limiting requests; try again shortly" : "Messaging service unavailable";
  return { status, message };
}

async function payload(request) {
  if (!request.body) reject(400, "Expected a JSON object");
  const chunks = [];
  let size = 0;
  for await (const part of request.body) {
    size += part.length;
    if (size > MAX_REQUEST_BYTES) reject(413, "Message too large");
    chunks.push(part);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {}
  reject(400, "Expected a JSON object");
}

function recipient(cfg, target, exact = false) {
  if (typeof target !== "string") reject(400, "Select a recipient");
  const [role, session, ...extra] = target.split("#");
  if (target === "all" && !exact) return role;
  if (!isValidName(role) || role === "all" || extra.length ||
      ((session !== undefined || exact) && (typeof session !== "string" || !SESSION_LABEL.test(session))) ||
      (cfg.peers.length && !cfg.peers.includes(role))) reject(400, "Invalid recipient");
  return role;
}

// CSRF guard for state-changing requests: the browser must send the UI's own origin.
export function assertSameOrigin(request, allowedOrigin) {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  const host = request.headers.get("host") || new URL(request.url).host;
  const local = /^127\.0\.0\.1(:\d+)?$/.test(host);
  const fromUi = (allowedOrigin && origin === allowedOrigin) || (local && origin === "http://" + host);
  if ((site && site !== "same-origin") || !fromUi) reject(403, "Same-origin request required");
}

export function createUi({ cfg, projects: configs = cfg ? [cfg] : [], allowedOrigin = "", control = controlSession, setMode = publishMode, env = process.env, start = startSession, models = listModels, push: notifier = null, auth = null }) {
  if (!configs.length) throw new Error("No ai-collab project is configured");
  for (const item of configs) if (!item.enabled) throw new Error(item.reason);
  if (allowedOrigin && (!allowedOrigin.startsWith("https://") || new URL(allowedOrigin).origin !== allowedOrigin)) {
    throw new Error("AI_COLLAB_UI_ORIGIN must be a single HTTPS origin without a trailing slash");
  }
  const clients = new Set();
  const hubs = new Map();
  const known = new Set();
  const projects = new Map();
  let pushTimer = null;
  let lastStartAt = 0;
  let closed = false;

  function broadcast() {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      for (const client of clients) if (client.ready) push(client);
    }, PUSH_DELAY_MS);
    pushTimer.unref?.();
  }

  // Adds a project once; a hub new to this instance gets its listener, and push keeps its topics open.
  function addProject(item) {
    if (projects.has(item.project) || closed) return false;
    // Projects on the same ntfy server and account share one hub, hence one streaming subscription.
    const key = item.url + "\n" + item.token;
    if (!hubs.has(key)) {
      const hub = createHub(item, { keep: name => known.has(name) });
      hubs.set(key, hub);
      hub.listen((name, events) => {
        for (const project of projects.values()) {
          if (project.hub !== hub) continue;
          if (name === project.status) latestStatuses(events, project.statuses);
          if (name === project.receipts) readReceipts(events, project.reads);
          if (notifier) notifyActions(project, name, events);
        }
        broadcast();
      });
    }
    const registry = join(item.stateDir, item.project, "registry");
    mkdirSync(registry, { recursive: true, mode: 0o700 });
    const watcher = watch(registry, broadcast);
    watcher.unref();
    const project = {
      cfg: item, hub: hubs.get(key), watcher,
      operator: { ...item, peer: "operator", session: "" },
      topic: broadcastTopic(item.project), status: statusTopic(item.project), activity: activityTopic(item.project),
      receipts: receiptsTopic(item.project),
      inboxes: new Map(item.peers.map(peer => [peer, inboxTopic(item.project, peer)])),
      wakes: new Map(), statuses: new Map(), reads: new Map(), recipients: new Map(),
    };
    for (const name of [project.topic, project.status, project.activity, project.receipts, ...project.inboxes.values()]) known.add(name);
    projects.set(item.project, project);
    // The sender keeps every project's broadcast and inbox topics open, so notifications go out with no browser tab open.
    if (notifier) {
      const open = name => project.hub.open(name).catch(() => {
        if (!closed) setTimeout(() => open(name), NOTIFY_RETRY_MS).unref?.();
      });
      for (const name of [project.topic, ...project.inboxes.values()]) open(name);
    }
    broadcast();
    return true;
  }
  for (const item of configs) addProject(item);
  const fallback = projects.values().next().value;

  // New approvals, choice cards, questions, and direct messages to the operator become one push each.
  function notifyActions(project, topic, added) {
    const name = project.cfg.project;
    const fresh = added.filter(event => Date.now() - event.time * 1000 < NOTIFY_RECENT_MS);
    const send = (id, fields) => notifier.notify(name + ":" + id, notice({ project: name, id, ...fields })).catch(() => {});
    if (topic === project.topic) {
      const { ends, replies } = outcomes(project.hub.events(topic));
      for (const event of fresh) {
        const item = baseEntry(event);
        if (item?.kind === "Approval") {
          const { id, harness, tool, summary, questions, expiresAt } = item.approval;
          if (ends.has(id) || replies.has(id) || (expiresAt && expiresAt < Date.now())) continue;
          send(id, questions ? { kind: "choice", sender: item.sender, harness, text: questions[0].question, important: true }
            : { kind: "approval", sender: item.sender, harness, tool, text: summary, important: true });
        } else if (item?.kind === "Question" && !replies.has(item.question)) {
          const important = item.body.startsWith(IMPORTANT_PREFIX);
          send(item.question, { kind: "question", sender: item.sender, text: important ? item.body.slice(IMPORTANT_PREFIX.length) : item.body, important });
        }
      }
    } else if ([...project.inboxes.values()].includes(topic)) {
      for (const event of fresh) {
        const item = baseEntry(event);
        if (item?.kind === "Message" && item.to === "operator" && item.thread && item.from !== "operator") send(event.id, { kind: "message", sender: item.from, text: item.body });
      }
    }
  }

  function projectFor(name) {
    if (name === undefined || name === null || name === "") return fallback;
    if (!projects.has(name)) reject(400, "Unknown project");
    return projects.get(name);
  }

  // An @session gets the post in its direct chat; an @harness reaches its running sessions, or starts one with the post as prompt.
  async function routeMentions(project, body, target, by) {
    const { cfg, operator } = project;
    const sessions = listSessions(cfg);
    const direct = to => sendMessage(operator, to, body, { operatorThread: true, ...(by ? { by } : {}) });
    const notes = [];
    for (const name of mentionedNames(body, cfg.peers)) {
      if (name === target) continue;
      if (name.includes(":")) {
        const [harness, model] = [name.slice(0, name.indexOf(":")), name.slice(name.indexOf(":") + 1)];
        if (!startable(project).includes(harness)) notes.push("@" + name + " not available here");
        else if (!(await models(cfg.stateDir, env, { peers: cfg.peers }))[harness]?.includes(model)) notes.push("@" + name + " unknown model");
        else notes.push("@" + name + await startFor(cfg, body, { harness, model }));
        continue;
      }
      if (name.includes("#")) {
        if (sessions.some(item => item.id === name)) { await direct(name); notes.push("@" + name + " sent"); } else notes.push("@" + name + " unknown");
        continue;
      }
      const running = sessions.filter(item => item.peer === name && item.online && item.id !== target);
      if (running.length) {
        for (const item of running) await direct(item.id);
        notes.push("@" + name + " sent to " + running.length + (running.length === 1 ? " session" : " sessions"));
        continue;
      }
      if (sessions.some(item => item.peer === name && item.id === target)) continue;
      if (!startable(project).includes(name)) { notes.push("@" + name + " not available here"); continue; }
      notes.push("@" + name + await startFor(cfg, body, { harness: name }));
    }
    return notes.join(" · ");
  }

  // Starts a mention's session in the project folder, one start per START_GAP_MS; returns the note after the tag.
  async function startFor(cfg, body, options) {
    const checked = checkPrompt(body);
    if (checked.error) return ": " + checked.error;
    if (Date.now() - lastStartAt < START_GAP_MS) return ": wait 10 seconds between starts";
    lastStartAt = Date.now();
    const result = await start(cfg, { ...options, prompt: checked.text, env, place: "folder" });
    return result.status === "failed" ? " start failed: " + result.detail : " starting a new session";
  }

  function inboxOf(project, peer) {
    return project.inboxes.get(peer) || inboxTopic(project.cfg.project, peer);
  }

  function wakeAgent(project, target, session) {
    const { wakes, cfg } = project;
    if (!session) return { status: "unsupported", detail: "This agent must register its local session before it can be woken." };
    // A running session needs no wake; receipts show when it reads the message.
    if (session.online) return { status: "online" };
    if (wakes.get(target)?.status !== "waking") {
      // at lets the UI drop the banner once the session reports after the wake began (visibleWake).
      const at = Date.now();
      wakes.set(target, { status: "waking", detail: "Waking the selected session.", at });
      void Promise.resolve().then(() => control("wake", session, { cfg })).then(
        result => wakes.set(target, { ...result, at }),
        () => wakes.set(target, { status: "failed", detail: "The session could not be woken.", at }),
      ).finally(broadcast);
    }
    return wakes.get(target);
  }

  // Latest msg time (ms) per sender address and per harness, from hub history already in memory.
  function lastMessages(project) {
    const last = new Map();
    const note = (key, at) => { if (at > (last.get(key) || 0)) last.set(key, at); };
    for (const name of [project.topic, ...project.inboxes.values()]) {
      for (const event of project.hub.events(name)) {
        const envelope = parseEnvelope(event.message);
        if (envelope?.kind !== "msg" || !isValidName(envelope.from) || envelope.from === "operator") continue;
        const at = event.time * 1000;
        note(envelope.from, at);
        if (typeof envelope.session === "string" && SESSION_LABEL.test(envelope.session)) note(`${envelope.from}#${envelope.session}`, at);
      }
    }
    return last;
  }

  function agents(project, last) {
    const { cfg, statuses, wakes } = project;
    const allowed = peer => peer !== "operator" && (!cfg.peers.length || cfg.peers.includes(peer));
    const found = new Map();
    for (const [id, at] of last) {
      const [peer, session] = id.split("#");
      if (session && allowed(peer)) found.set(id, { id, peer, session, seenAt: at, online: false });
    }
    for (const [id, state] of statuses) {
      const [peer, session] = id.split("#");
      if (!session || !allowed(peer)) continue;
      const seenAt = Date.parse(state.ts) || 0;
      found.set(id, { id, peer, session, seenAt, online: state.event === "start" && Date.now() - seenAt < ONLINE_MS, ...(state.parent ? { parent: state.parent } : {}) });
    }
    // Hooks refresh seenAt on every event; minute resolution keeps snapshot pushes to one per agent per minute.
    for (const { id, peer, session, online, seenAt, parent, cwd, name } of listSessions(cfg)) {
      const started = typeof parent === "string" && PARENT.test(parent) ? parent : found.get(id)?.parent;
      found.set(id, {
        id, peer, session, online, seenAt, activeAt: Math.floor((seenAt || 0) / 60_000) * 60_000, registered: true, ...(started ? { parent: started } : {}),
        ...(typeof cwd === "string" && isAbsolute(cwd) ? { folder: cleanText(basename(cwd), ACTIVITY_NAME_MAX) } : {}),
        ...(cleanName(name) ? { name: cleanName(name) } : {}),
      });
    }
    const prompts = firstPrompts(project);
    for (const [id, data] of found) {
      data.lastMessageAt = last.get(id) || 0;
      // Without a harness name: the folder and the first prompt's words, from activity in memory.
      if (!data.name) {
        const name = fallbackName(data.folder || "", prompts.get(id));
        if (name) data.name = name;
      }
      const wake = visibleWake(wakes.get(id), { ...data, statusAt: Date.parse(statuses.get(id)?.ts) || 0 });
      if (wake) data.wake = wake;
    }
    return [...found.values()].sort((a, b) => b.lastMessageAt - a.lastMessageAt || b.seenAt - a.seenAt || a.id.localeCompare(b.id));
  }

  // First prompt per session in activity history held in memory.
  function firstPrompts(project) {
    const first = new Map();
    for (const event of project.hub.events(project.activity)) {
      const item = activityItem(event);
      if (item?.type === "prompt" && item.input && !first.has(item.agent)) first.set(item.agent, item.input);
    }
    return first;
  }

  // Open approvals and unanswered questions per sender address, as chat entries the cards render.
  function pendingBySender(project, list) {
    const { ends, replies } = outcomes(project.hub.events(project.topic));
    const online = new Set(list.filter(agent => agent.online).map(agent => agent.id));
    const out = new Map();
    const add = (sender, item) => { if (!out.has(sender)) out.set(sender, []); out.get(sender).push(item); };
    for (const item of entries(project, project.topic, e => e.kind === "Approval" || e.kind === "Question")) {
      if (item.kind === "Approval") {
        const approval = approvalState(item.approval, ends, replies);
        if (approval.state !== "pending" || (approval.expiresAt && approval.expiresAt < Date.now())) continue;
        add(item.from, { ...item, project: project.cfg.project, approval, blocking: true, expiresAt: approval.expiresAt });
      } else if (item.question && !replies.has(item.question) && (online.has(item.from) || Date.now() - item.time * 1000 < ONLINE_MS)) {
        add(item.from, { ...item, project: project.cfg.project, blocking: IMPORTANT.test(item.body) });
      }
    }
    return out;
  }

  // Home and Sessions cards: each session's facts for sessionState(), its last action and running subagents.
  function sessionCards(project, list, mode) {
    const { cfg, statuses } = project;
    const rows = groupSubagents(activityRows(activityList(project)));
    const latest = new Map();
    const lastAction = new Map();
    const runs = new Map();
    for (const row of rows) {
      latest.set(row.agent, row);
      if (row.type === "subagent") {
        if (!row.done) { if (!runs.has(row.agent)) runs.set(row.agent, []); runs.get(row.agent).push(row); }
        if (row.last) lastAction.set(row.agent, { tool: row.last.tool, summary: row.last.summary, time: row.last.time, subagent: row.kind || "agent" });
      } else if (row.tool && (row.type === "tool_call" || row.type === "tool_result" || row.type === "error")) {
        lastAction.set(row.agent, { tool: row.tool, summary: summarize(row.input).slice(0, 160), time: row.time });
      }
    }
    const pending = pendingBySender(project, list);
    return list.map(agent => {
      const row = latest.get(agent.id);
      const lastAt = row ? Math.max(row.time, ...(row.rows || []).map(r => r.time)) * 1000 : 0;
      const statusAt = Date.parse(statuses.get(agent.id)?.ts) || 0;
      const open = row && row.type === "tool_call" && !row.result;
      // Unfinished runs; the browser counts only those with a row in the last 2 min (runState).
      const subagents = (runs.get(agent.id) || []).map(run => ({ id: run.id, agent: run.agent, run: run.run, kind: run.kind, description: run.description, steps: run.steps, time: run.time, lastTime: run.lastTime, last: run.last, open: run.open }));
      return {
        ...agent, project: cfg.project, harness: peerOf(agent.id), lastActivityAt: lastAt, ...(open ? { openCallAt: lastAt } : {}),
        afkHold: mode !== "off" && row?.type === "stop" && /^turn ended/.test(row.input || "") && statusAt < row.time * 1000,
        ...(lastAction.has(agent.id) ? { lastAction: lastAction.get(agent.id) } : {}), subagents, pending: pending.get(agent.id) || [],
      };
    });
  }

  function harnesses(project, list, last) {
    const names = project.cfg.peers.length ? project.cfg.peers : [...new Set(list.map(agent => agent.peer))].sort();
    return names.map(id => {
      const sessions = list.filter(agent => agent.peer === id);
      return { id, lastMessageAt: last.get(id) || 0, activeAt: Math.max(0, ...sessions.map(agent => agent.activeAt || 0)), sessions: sessions.length, online: sessions.filter(agent => agent.online).length };
    });
  }

  // Ticks for an operator message: read when every recipient read it, delivered when one was online then or since.
  function receiptOf(project, item, list) {
    const at = item.time * 1000;
    const [peer, session] = item.to.split("#");
    const targets = list.filter(agent => agent.session && (peer === "all" || agent.peer === peer) && (!session || agent.session === session));
    // Sessions online when the UI first saw the message; history older than ONLINE_MS has no such snapshot.
    if (!project.recipients.has(item.id)) {
      project.recipients.set(item.id, new Set(Date.now() - at < ONLINE_MS ? targets.filter(agent => agent.online).map(agent => agent.id) : []));
      for (const id of project.recipients.keys()) { if (project.recipients.size <= RECIPIENTS_MAX) break; project.recipients.delete(id); }
    }
    const online = project.recipients.get(item.id);
    const read = project.reads.get(item.id) || new Set();
    const since = targets.filter(agent => online.has(agent.id) || agent.online || agent.seenAt >= at).map(agent => agent.id);
    if (session) return read.has(item.to) ? "read" : since.length ? "delivered" : "sent";
    // A broadcast waits only for sessions online at send time; without any, for the sessions that read it.
    const waiting = online.size ? [...online] : [...read];
    if (waiting.length && waiting.every(id => read.has(id))) return "read";
    return since.length || read.size ? "delivered" : "sent";
  }

  function entries(project, name, keep) {
    return project.hub.events(name).map(entry).filter(item => item && keep(item));
  }

  // Zoom by sender: the whole project, one harness, or one session's direct thread.
  function messages(project, { harness, session }, agentList) {
    let list;
    if (session) {
      const thread = item => item.thread && ((item.from === "operator" && item.to === session) || (item.from === session && item.to === "operator"));
      list = [...entries(project, inboxOf(project, peerOf(session)), thread),
        ...entries(project, project.topic, item => item.from === session).map(item => ({ ...item, scope: "all" }))];
    } else if (harness) {
      const related = item => peerOf(item.from) === harness || peerOf(item.to) === harness || mentions(item.body, harness);
      list = [...entries(project, project.topic, related).map(item => ({ ...item, scope: "all" })),
        ...entries(project, inboxOf(project, harness), item => item.kind === "Message")];
    } else {
      list = entries(project, project.topic, () => true);
    }
    const { ends, replies, senders } = outcomes(project.hub.events(project.topic));
    const approvals = new Set(list.filter(item => item.kind === "Approval").map(item => item.approval.id));
    return list.filter(item => !(item.kind === "Reply" && approvals.has(item.question)))
      .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id)).slice(-MAX_MESSAGES)
      .map(item => {
        if (item.kind === "Approval") return { ...item, approval: approvalState(item.approval, ends, replies, senders) };
        if (item.kind === "Question" && replies.has(item.question)) {
          const by = senders.get(item.question)[0];
          return { ...item, answer: replies.get(item.question)[0], ...(by ? { answeredBy: by } : {}) };
        }
        return item.from === "operator" && item.kind === "Message" && item.to ? { ...item, receipt: receiptOf(project, item, agentList) } : item;
      });
  }

  // pending, sent (answered, the hook has not read it yet), or the end reason; with the decision or answers that applied.
  function approvalState(approval, ends, replies, senders = new Map()) {
    const decisions = (replies.get(approval.id) || []).map(answer => replyDecision(approval, answer));
    const at = decisions.findIndex(Boolean);
    const decision = decisions[at];
    const by = senders.get(approval.id)?.[at];
    const state = ends.get(approval.id) || (decision ? "sent" : "pending");
    return { ...approval, state, ...(decision ? { decision: decision.behavior, ...(decision.answers ? { answers: decision.answers } : {}), ...(by ? { by } : {}) } : {}) };
  }

  function findApproval(project, id) {
    if (typeof id !== "string" || !APPROVAL_ID.test(id)) reject(400, "Invalid approval");
    const item = project.hub.events(project.topic).map(entry).find(e => e?.kind === "Approval" && e.approval.id === id);
    if (!item) reject(404, "Unknown approval");
    const { ends } = outcomes(project.hub.events(project.topic));
    if (ends.has(id) || (item.approval.expiresAt && item.approval.expiresAt < Date.now())) reject(409, "This request has closed");
    return item.approval;
  }

  // Harnesses each project can start, cached because it scans PATH.
  function startable(project) {
    if (!project.startable || Date.now() - project.startable.at > STARTABLE_CACHE_MS) project.startable = { at: Date.now(), list: availableHarnesses(project.cfg, env) };
    return project.startable.list;
  }

  // Start places (folder, worktree, openshell) for the project, cached like startable().
  function startPlaces(project) {
    if (!project.places || Date.now() - project.places.at > STARTABLE_CACHE_MS) project.places = { at: Date.now(), list: availablePlaces(project.cfg, env) };
    return project.places.list;
  }

  function snapshot({ project, harness, session, scope }) {
    const last = lastMessages(project);
    const list = agents(project, last);
    const mode = latestMode([...projects.values()].flatMap(item => item.hub.events(item.topic))).mode;
    // Home covers every project's hub; Sessions only this project. Both ride the same pushed state event.
    const cards = scope === "home" ? [...projects.values()].flatMap(item => item === project ? sessionCards(item, list, mode)
      : item.failed ? [] : sessionCards(item, agents(item, lastMessages(item)), mode))
      : scope === "sessions" ? sessionCards(project, list, mode) : undefined;
    return {
      project: project.cfg.project, operator: project.operator.peer, mode,
      projects: [...projects.values()].map(item => ({ id: item.cfg.project, peers: item.cfg.peers })),
      view: { harness, session, ...(scope ? { scope } : {}) },
      harnesses: harnesses(project, list, last),
      agents: list,
      messages: scope === "home" ? [] : messages(project, { harness, session }, list),
      ...(cards ? { sessions: cards } : {}),
      ...(scope === "home" ? { unavailable: [...projects.values()].filter(item => item.failed).map(item => item.cfg.project) } : {}),
      startable: startable(project),
      startPlaces: startPlaces(project),
    };
  }

  // One session's activity, or every allowed agent's for the project overview, oldest first.
  function activityList(project, session) {
    const { cfg } = project;
    return project.hub.events(project.activity).map(activityItem).filter(item => item &&
      (!cfg.peers.length || cfg.peers.includes(peerOf(item.agent))) && (!session || item.agent === session));
  }

  // Activity travels as deltas: a reset with the full list, then only rows newer than the last one sent.
  function pushActivity(client) {
    if (!client.activity) return;
    const list = activityList(client.project, client.session);
    const at = client.activitySent === undefined ? -1 : list.findIndex(item => item.id === client.activitySent);
    const reset = at < 0 && !(client.activitySent === "" && list.length === 0);
    const items = reset ? list : list.slice(at + 1);
    if (!reset && !items.length) return;
    client.activitySent = list.at(-1)?.id ?? "";
    client.write(`event: activity\ndata: ${JSON.stringify({ reset, items })}\n\n`);
  }

  function push(client) {
    const state = JSON.stringify(snapshot(client));
    if (state !== client.last) {
      client.last = state;
      client.write(`event: state\ndata: ${state}\n\n`);
    }
    pushActivity(client);
  }

  async function load(client) {
    const { project, harness, session } = client;
    const { hub } = project;
    try {
      const required = [project.status, project.topic];
      if (harness) required.push(inboxOf(project, harness));
      // Activity is required only in an Activity view; it keeps the newest history when the cache exceeds the poll cap.
      const activity = hub.open(project.activity, { tailBytes: ACTIVITY_TAIL_BYTES });
      if (!client.activity) activity.catch(() => {});
      // Other inboxes feed last-message times and receipts feed ticks; a failure is tolerated. Opening all at once lets the hub subscribe once.
      const optional = Promise.allSettled([project.receipts, ...project.inboxes.values()].filter(name => !required.includes(name)).map(name => hub.open(name)));
      await Promise.all([...required.map(name => hub.open(name)), client.activity || client.scope ? activity : null]);
      await optional;
      // Home needs status, broadcast and activity of every other project; one that fails is listed as unavailable.
      if (client.scope === "home") {
        await Promise.all([...projects.values()].filter(item => item !== project).map(async item => {
          const opened = await Promise.allSettled([item.status, item.topic, item.activity].map(name =>
            item.hub.open(name, name === item.activity ? { tailBytes: ACTIVITY_TAIL_BYTES } : undefined)));
          item.failed = opened.some(result => result.status === "rejected");
        }));
      }
      client.ready = true;
      push(client);
    } catch (err) {
      client.write(`event: problem\ndata: ${JSON.stringify({ error: failure(err).message })}\n\n`);
    }
  }

  function view(url) {
    const project = projectFor(url.searchParams.get("project"));
    const { cfg } = project;
    const session = url.searchParams.get("session") || "";
    let harness = url.searchParams.get("harness") || "";
    if (session) harness = recipient(cfg, session, true);
    else if (harness && (!isValidName(harness) || harness === "all" || harness === "operator" ||
        (cfg.peers.length && !cfg.peers.includes(harness)))) reject(400, "Unknown harness");
    // view=activity adds the activity stream: one session's, or the project overview without a session.
    const mode = url.searchParams.get("view");
    // view=home adds every project's session cards; view=sessions this project's.
    const scope = mode === "home" || mode === "sessions" ? mode : "";
    return { project, harness: scope === "home" ? "" : harness, session: scope === "home" ? "" : session, activity: mode === "activity", scope };
  }

  // The signed-in GitHub user, or a 401 while sign-in is on; null while it is off.
  function caller(request) {
    if (!auth) return null;
    return auth.user(request) || reject(401, "Sign in with GitHub");
  }

  // /api/auth/<step>; without github.json only "me" answers, saying sign-in is off.
  async function authApi(request, step) {
    if (auth) return auth.route(request, step);
    return step === "me" ? json(200, { enabled: false, user: null }) : json(404, { error: "GitHub sign-in is not configured" });
  }

  function events(request) {
    let selected;
    try {
      caller(request);
      selected = view(new URL(request.url));
    } catch (err) {
      return json(err.status || 400, { error: err.message });
    }
    let client;
    let keepalive;
    const close = () => {
      clearInterval(keepalive);
      clients.delete(client);
    };
    const body = new ReadableStream({
      start(controller) {
        client = {
          ...selected, ready: false, last: "",
          write(text) {
            try { controller.enqueue(encoder.encode(text)); } catch { close(); }
          },
        };
        clients.add(client);
        keepalive = setInterval(() => client.write(": keepalive\n\n"), KEEPALIVE_MS);
        keepalive.unref?.();
        request.signal?.addEventListener("abort", close, { once: true });
        void load(client);
      },
      cancel: close,
    });
    return new Response(body, {
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" },
    });
  }

  async function handle(request, action) {
    try {
      if (request.method !== "POST" || !ACTIONS.includes(action)) reject(404, "Unknown route");
      const by = caller(request)?.login;
      assertSameOrigin(request, allowedOrigin);
      if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") reject(415, "JSON required");
      const { project: name, target, body, question, mode, id, decision, answers, harness, prompt, place, worktree, openshell, urgent, model } = await payload(request);
      if (action === "afk") {
        if (!MODES.includes(mode)) reject(400, "Mode must be on, off, or quiet");
        await setMode([...projects.values()].map(item => item.cfg), mode, by);
        return json(201, { status: "AFK " + mode, detail: "Sent to " + projects.size + (projects.size === 1 ? " project" : " projects") });
      }
      const project = projectFor(name);
      const { cfg, operator, topic } = project;
      if (action === "approve") {
        const approval = findApproval(project, id);
        let answer;
        if (approval.questions) {
          if (!answers || typeof answers !== "object" || Array.isArray(answers)) reject(400, "Answer every question");
          answer = JSON.stringify(answers);
          if (answer.length > ANSWER_MAX_CHARS || !parseChoice(approval.questions, answer)) reject(400, "Answer every question");
        } else {
          if (!["allow", "deny"].includes(decision)) reject(400, "Decision must be allow or deny");
          answer = decision;
        }
        await publish(cfg, topic, `reply ${id} ${answer}`, { title: replyTitle(cfg, by) });
        return json(201, { sent: true, status: approval.questions ? "Answer sent" : decision === "allow" ? "Allow sent" : "Deny sent" });
      }
      if (action === "models") return json(200, await models(cfg.stateDir, env, { peers: cfg.peers }));
      if (action === "start") {
        if (!startable(project).includes(harness)) reject(400, "That harness is not available for this project");
        // The UI sends worktree / openshell booleans; place is the same choice by name.
        if (worktree === true && openshell === true) reject(400, "Pick a worktree or openshell, not both");
        const where = place ?? (worktree === true ? "worktree" : openshell === true ? "openshell" : undefined);
        if (where !== undefined && !startPlaces(project).includes(where)) reject(400, "That start place is not available for this project");
        const checked = checkPrompt(prompt);
        if (checked.error) reject(400, checked.error);
        const chosen = model === undefined || model === null || model === "" ? undefined : model;
        if (chosen !== undefined && (typeof chosen !== "string" || !(await models(cfg.stateDir, env, { peers: cfg.peers }))[harness]?.includes(chosen))) {
          reject(400, "That model is not available for this harness");
        }
        if (Date.now() - lastStartAt < START_GAP_MS) reject(429, "Wait 10 seconds between starts");
        lastStartAt = Date.now();
        return json(201, await start(cfg, { harness, prompt: checked.text, env, place: where || "folder", ...(chosen !== undefined ? { model: chosen } : {}) }));
      }
      // A queued message is already on ntfy: the urgent marker makes the recipient's next hook poll at once.
      if (action === "nudge") {
        recipient(cfg, target, true);
        markUrgent(operator, target);
        return json(200, { status: "Sending at the agent's next tool call" });
      }
      if (action === "compact" || action === "wake") {
        recipient(cfg, target, true);
        const session = listSessions(cfg).find(item => item.id === target);
        if (action === "wake") return json(200, wakeAgent(project, target, session));
        return json(200, await control("compact", session, { cfg }));
      }
      if (typeof body !== "string" || !body.trim() || body.length > 4000) reject(400, "Enter 1–4000 characters");
      if (action === "reply" || question !== undefined) {
        if (typeof question !== "string" || !/^[a-f0-9]{12}$/.test(question) || (target && target !== "all")) reject(400, "Invalid question");
        const reply = `reply ${question} ${body.trim()}`;
        if (body.trim().length > 2000 || Buffer.byteLength(reply) > NTFY_MESSAGE_MAX_BYTES) reject(400, "Reply exceeds the size limit");
        await publish(cfg, topic, reply, { title: replyTitle(cfg, by) });
        return json(201, { sent: true });
      }
      recipient(cfg, target);
      const direct = action === "send" && target.includes("#");
      try {
        if (urgent !== undefined && typeof urgent !== "boolean") reject(400, "urgent must be true or false");
        const sender = direct || action === "send" ? operator : cfg;
        await sendMessage(sender, target, body.trim(), { operatorThread: direct, urgent: urgent === true, ...(by && sender.peer === "operator" ? { by } : {}) });
      } catch (err) {
        if (err.message.includes("-byte limit")) reject(400, `Message exceeds ${NTFY_MESSAGE_MAX_BYTES} encoded bytes`);
        throw err;
      }
      const routed = action === "send" ? await routeMentions(project, body.trim(), target, by) : "";
      const detail = routed ? { status: "Sent", detail: routed } : {};
      if (direct) return json(201, { sent: true, ...detail, wake: wakeAgent(project, target, listSessions(cfg).find(item => item.id === target)) });
      return json(201, { sent: true, ...detail });
    } catch (err) {
      const { status, message } = failure(err);
      return json(status, { error: message });
    }
  }

  // GET key, POST/DELETE subscribe, POST test: the browser's push subscription and a test notification.
  async function pushApi(request, action) {
    try {
      caller(request);
      if (!PUSH_ACTIONS.includes(action)) reject(404, "Unknown route");
      if (!notifier) reject(404, "Notifications are not configured");
      if (action === "key") {
        if (request.method !== "GET") reject(405, "Method not allowed");
        return json(200, { publicKey: notifier.publicKey() });
      }
      if (!(action === "subscribe" ? ["POST", "DELETE"] : ["POST"]).includes(request.method)) reject(405, "Method not allowed");
      assertSameOrigin(request, allowedOrigin);
      if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") reject(415, "JSON required");
      const { subscription, endpoint } = await payload(request);
      if (action === "subscribe" && request.method === "POST") {
        notifier.subscribe(subscription);
        return json(201, { subscribed: true });
      }
      if (typeof endpoint !== "string" || !endpoint) reject(400, "Endpoint required");
      if (action === "subscribe") return json(200, { removed: notifier.unsubscribe(endpoint) });
      if (!notifier.subscriptions().some(item => item.endpoint === endpoint)) reject(404, "This browser is not subscribed");
      const result = await notifier.send({ title: "AI Collab test", body: "Notifications reach this device.", tag: "test", url: "/", important: false }, { endpoint });
      return json(result.sent ? 201 : 502, result.sent ? { sent: true } : { error: "The push service did not accept the test" });
    } catch (err) {
      const { status, message } = failure(err);
      return json(status, { error: message });
    }
  }

  /**
   * Serves an attachment that appears in a loaded project's history; anything else is 404.
   * Images come from chat topics; text/plain comes only from the activity topic (a large tool result).
   */
  async function file(name, request) {
    if (auth && !(request && auth.user(request))) return json(401, { error: "Sign in with GitHub" });
    const text = TEXT_FILE_NAME.test(name);
    if (!text && !FILE_NAME.test(name)) return new Response("Not found", { status: 404 });
    for (const project of projects.values()) {
      const topics = text ? [project.activity] : [project.topic, ...project.inboxes.values()];
      const found = topics.some(topic => project.hub.events(topic).some(event => attachmentOf(event, { text })?.file === name));
      if (!found) continue;
      const res = await fetch(`${project.cfg.url}/file/${name}`, {
        headers: project.cfg.token ? { authorization: `Bearer ${project.cfg.token}` } : {},
        signal: AbortSignal.timeout(30_000),
      }).catch(() => null);
      const type = res?.headers.get("content-type") || "";
      if (!res?.ok || !(text ? TEXT_TYPE.test(type) : /^image\//.test(type))) {
        await res?.arrayBuffer().catch(() => {});
        return new Response("Attachment unavailable", { status: 502 });
      }
      return new Response(res.body, { headers: {
        "content-type": text ? "text/plain; charset=utf-8" : type, "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff", "content-disposition": "inline",
        ...(text ? { "content-security-policy": "sandbox; default-src 'none'" } : {}),
      } });
    }
    return new Response("Not found", { status: 404 });
  }

  return {
    auth: authApi,
    events,
    file,
    handle,
    push: pushApi,
    /** Adds every enabled config not yet watched (auto-joined repos); returns how many were added. */
    refresh(list) {
      return list.filter(item => item.enabled && addProject(item)).length;
    },
    close() {
      closed = true;
      for (const client of clients) client.write = () => {};
      clients.clear();
      clearTimeout(pushTimer);
      for (const project of projects.values()) project.watcher.close();
      for (const hub of hubs.values()) hub.close();
    },
  };
}

// Process-wide instance shared by every route bundle; tests may install their own first.
export function ui() {
  if (!globalThis[INSTANCE]) {
    const listed = loadProjects(process.env, { host: "operator" });
    const projects = listed.length ? listed
      : [loadConfig(process.env, { cwd: process.env.AI_COLLAB_UI_WORKSPACE || process.cwd(), host: "operator" })];
    // VAPID subject: the UI's HTTPS origin, or a mailto: placeholder without one.
    const push = createPush({ dir: join(projects[0].stateDir, "push"), subject: process.env.AI_COLLAB_UI_ORIGIN || "mailto:ai-collab@localhost.invalid" });
    // GitHub sign-in turns on with ${configDir}/github.json.
    const auth = createAuth({ dir: configDir(process.env), stateDir: projects[0].stateDir, origin: process.env.AI_COLLAB_UI_ORIGIN });
    const instance = createUi({ projects, allowedOrigin: process.env.AI_COLLAB_UI_ORIGIN, push, auth });
    // Repos that auto-join after start-up appear within one refresh interval.
    setInterval(() => instance.refresh(loadProjects(process.env, { host: "operator" })), REFRESH_MS).unref();
    globalThis[INSTANCE] = instance;
  }
  return globalThis[INSTANCE];
}

export function installUi(instance) {
  globalThis[INSTANCE] = instance;
  return instance;
}
