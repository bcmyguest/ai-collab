// Limit alert: one choice card per session and limit window. Nothing switches automatically; the operator picks.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeEnvelope } from "./agui.mjs";
import { broadcastTopic } from "./config.mjs";
import { deepLink } from "./deep-link.mjs";
import { alertPriority, readAlertLevel } from "./alerts.mjs";
import { publish } from "./ntfy.mjs";
import { listModels } from "./models.mjs";
import { publishActivity } from "./activity.mjs";
import { START_HARNESSES, availableHarnesses, modelShape, startSession } from "./start.mjs";
import { listSessions } from "./sessions.mjs";
import { listRuns } from "./pattern-runs.mjs";
import { statePath, withLock, writeState } from "./state.mjs";

export const WAIT_LABEL = "Wait for reset";
export const LIMIT_TOOL = "usage_limit";
export const REPLACEMENT_MAX = 4;
// A limit with no reset time stays silent for this long per session and window.
export const UNKNOWN_RESET_MS = 5 * 3600_000;
const HANDOFF_FIELD_MAX = 1500;
const ACTIVITY_LIMIT_MS = 1500;

const pad = (n) => String(n).padStart(2, "0");

/** "harness:model" when the model is known, else the harness. */
export const who = (harness, model) => (model ? `${harness}:${model}` : harness);

/** Local HH:MM of a reset time (ms), or "" when unknown. */
export function resetClock(resetsAt) {
  if (!Number.isFinite(resetsAt)) return "";
  const at = new Date(resetsAt);
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** The card's and timeline's line: "Limit reached · claude:claude-opus-5-5 · 5-hour · resets 18:00". */
export function limitLine({ harness, model, windowName, resetsAt }) {
  return ["Limit reached", who(harness, model), windowName, resetsAt ? `resets ${resetClock(resetsAt)}` : "reset time unknown"]
    .filter(Boolean).join(" · ");
}

// A role's fallback as {harness, model}, or null; read defensively, since the attribute is optional.
function fallbackOf(fallback) {
  if (typeof fallback !== "string") return null;
  const at = fallback.indexOf(":");
  if (at < 1) return null;
  const harness = fallback.slice(0, at);
  const model = fallback.slice(at + 1);
  return START_HARNESSES.includes(harness) && modelShape(harness, model) ? { harness, model } : null;
}

/**
 * Replacement options: the role's fallback first, then the first listed model of each other available harness, at most REPLACEMENT_MAX.
 * Returns [{label, harness, model, description?}]; the caller appends WAIT_LABEL.
 */
export function replacementOptions({ harness, model, fallback, models, available }) {
  const picks = [];
  const fb = fallbackOf(fallback);
  if (fb) picks.push({ ...fb, description: "Role fallback" });
  for (const other of available) {
    if (other === harness || !START_HARNESSES.includes(other)) continue;
    const first = (models?.[other] ?? []).find((name) => modelShape(other, name));
    if (first) picks.push({ harness: other, model: first });
  }
  const seen = new Set([who(harness, model)]);
  const out = [];
  for (const pick of picks) {
    const label = who(pick.harness, pick.model);
    if (seen.has(label) || out.length >= REPLACEMENT_MAX) continue;
    seen.add(label);
    out.push({ label, harness: pick.harness, model: pick.model, ...(pick.description ? { description: pick.description } : {}) });
  }
  return out;
}

/** The brief for a replacement session: the original task and last activity, trimmed, with the limit that stopped it. */
export function handoffPrompt({ from, harness, model, windowName, task, activity }) {
  const clip = (text) => (typeof text === "string" ? text.trim().slice(0, HANDOFF_FIELD_MAX) : "");
  const lines = [
    `Continue the work that ${from} (${who(harness, model)}) left when it hit a ${windowName || "usage"} limit.`,
    clip(task) ? `Original task: ${clip(task)}` : "Original task: not recorded; ask the operator for it before changing anything.",
    clip(activity) ? `Last activity: ${clip(activity)}` : "",
    "Check the repository state before you edit anything.",
  ];
  return lines.filter(Boolean).join("\n\n");
}

/** Whether an alert for a window is still in force: a known reset holds until it passes, an unknown one for UNKNOWN_RESET_MS. */
export function limitInForce(entry, now) {
  if (!entry || !Number.isFinite(entry.at)) return false;
  return Number.isFinite(entry.resetsAt) ? now < entry.resetsAt : now < entry.at + UNKNOWN_RESET_MS;
}

function alertsFile(cfg) {
  return statePath(cfg).replace(/\.json$/, ".limits.json");
}

function readAlerted(cfg) {
  try {
    const value = JSON.parse(readFileSync(alertsFile(cfg), "utf8"));
    return value && typeof value.windows === "object" ? value.windows : {};
  } catch {
    return {};
  }
}

/** The `fallback` attribute of the pattern role this session runs, or undefined (none, or not in a pattern run). */
export function roleFallback(cfg, address) {
  for (const run of listRuns(cfg)) {
    const role = Object.entries(run.sessions ?? {}).find(([, value]) => value === address)?.[0];
    if (role !== undefined) return run.definition?.roles?.find((item) => item?.id === role)?.fallback;
  }
  return undefined;
}

/** Where the answer handler finds a card's session, models and handoff: one JSON file per card. */
export function cardFile(cfg, id) {
  return join(cfg.stateDir, cfg.project, "limit-cards", `${id}.json`);
}

/** The stored card for a card ID, or null. */
export function readCard(cfg, id) {
  try {
    return JSON.parse(readFileSync(cardFile(cfg, id), "utf8"));
  } catch {
    return null;
  }
}

function writeCard(cfg, card) {
  mkdirSync(join(cfg.stateDir, cfg.project, "limit-cards"), { recursive: true, mode: 0o700 });
  writeFileSync(cardFile(cfg, card.id), `${JSON.stringify(card)}\n`, { mode: 0o600 });
}

/**
 * Acts on the operator's pick for a limit card. "Wait for reset" only acknowledges. A replacement starts a new session in the
 * project folder with the handoff prompt; the original session stays running. One pick per card: a second pick is a duplicate.
 * Returns {status: "waiting" | "started" | "duplicate" | "failed", detail, session?}.
 */
export async function chooseLimit(cfg, { id, label, start = startSession, env = process.env, now = Date.now() } = {}) {
  if (label === WAIT_LABEL) return { status: "waiting", detail: "Waiting for reset" };
  const claim = await withLock(cardFile(cfg, id), () => {
    const card = readCard(cfg, id);
    if (!card) return { problem: "failed", detail: "This limit card is unknown" };
    if (card.chosen) return { problem: "duplicate", detail: "This limit already has an answer" };
    const option = card.replacements.find((r) => r.label === label);
    if (!option) return { problem: "failed", detail: "That option is not on this limit card" };
    writeCard(cfg, { ...card, chosen: label, chosenAt: now });
    return { card, option };
  });
  if (!claim.locked) return { status: "failed", detail: "The limit card is busy; try again" };
  if (claim.value.problem) return { status: claim.value.problem, detail: claim.value.detail };
  const { card, option } = claim.value;
  const from = `${card.peer}#${card.session}`;
  const prompt = handoffPrompt({ from, harness: card.harness, model: card.model, windowName: card.windowName, task: card.name, activity: card.activity });
  const result = await start(cfg, { harness: option.harness, model: option.model, prompt, env, place: "folder" }).catch((error) => ({ status: "failed", detail: error.message }));
  if (result.status !== "started") {
    await withLock(cardFile(cfg, id), () => writeCard(cfg, { ...readCard(cfg, id), chosen: undefined, chosenAt: undefined }));
    return { status: "failed", detail: result.detail };
  }
  await withLock(cardFile(cfg, id), () => writeCard(cfg, { ...readCard(cfg, id), replacedBy: result.session }));
  // Each session's timeline links to the other: the original gets the replacement, the replacement its origin.
  const origin = { ...cfg, peer: card.peer, session: card.session };
  const [newPeer, newLabel] = result.session.split("#");
  await publishActivity(origin, card.harness, [{ type: "handoff", input: `Replacement started: ${result.session}` }], { timeoutMs: ACTIVITY_LIMIT_MS }).catch(() => 0);
  await publishActivity({ ...cfg, peer: newPeer, session: newLabel }, option.harness, [{ type: "handoff", input: `Continues ${from} after a limit` }], { timeoutMs: ACTIVITY_LIMIT_MS }).catch(() => 0);
  return { status: "started", detail: result.detail, session: result.session, from };
}

// Sets or clears one window's entry in the session's alert file; the reservation holds before the publish.
async function setWindow(cfg, window, entry) {
  await withLock(alertsFile(cfg), () => {
    const windows = { ...readAlerted(cfg) };
    if (entry) windows[window] = entry;
    else delete windows[window];
    writeState(alertsFile(cfg), { windows });
  });
}

/**
 * Publishes one limit card for this session and window unless an alert for the window is still in force.
 * limit is a classifyLimit result (lib/limits.mjs). Returns {status: "sent", id, options, line} or {status: "duplicate"}.
 */
export async function alertLimit(cfg, { harness, limit, env = process.env, now = Date.now(), send = publish, listed = listModels, available = availableHarnesses, fallback = roleFallback(cfg, `${cfg.peer}#${cfg.session}`) } = {}) {
  const sessionKey = `${cfg.peer}#${cfg.session}`;
  const window = limit.window ?? "unknown";
  const reserved = await withLock(alertsFile(cfg), () => {
    if (limitInForce(readAlerted(cfg)[window], now)) return false;
    writeState(alertsFile(cfg), { windows: { ...readAlerted(cfg), [window]: { at: now, resetsAt: limit.resetsAt ?? null } } });
    return true;
  });
  if (reserved.locked && !reserved.value) return { status: "duplicate" };
  try {
    const record = listSessions(cfg).find((s) => s.id === sessionKey) ?? {};
    const model = record.model || "";
    const models = await listed(cfg.stateDir, env, { peers: cfg.peers });
    const replacements = replacementOptions({ harness, model, fallback, models, available: available(cfg, env) });
    const options = [...replacements.map(({ label, description }) => ({ label, ...(description ? { description } : {}) })), { label: WAIT_LABEL }];
    const text = limitLine({ harness, model, windowName: limit.windowName, resetsAt: limit.resetsAt });
    const id = randomBytes(6).toString("hex");
    const questions = [{ question: text, header: "Limit reached", multiSelect: false, options }];
    const message = encodeEnvelope("approval", {
      from: cfg.peer, session: cfg.session, harness, id, tool: LIMIT_TOOL, summary: text, expiresAt: 0, questions, ts: new Date(now).toISOString(),
    }, cfg.wire);
    await send(cfg, broadcastTopic(cfg.project), message, {
      title: `Limit reached for ${sessionKey}`, click: deepLink({ project: cfg.project, session: cfg.session }), priority: alertPriority(readAlertLevel(env), "question"),
    });
    writeCard(cfg, {
      id, project: cfg.project, peer: cfg.peer, session: cfg.session, harness, model, windowName: limit.windowName ?? null, resetsAt: limit.resetsAt ?? null,
      replacements: replacements.map(({ label, harness: h, model: m }) => ({ label, harness: h, model: m })),
      name: record.name || "", activity: record.activity || "", at: now,
    });
    await publishActivity(cfg, harness, [{ type: "limit", input: text }], { timeoutMs: ACTIVITY_LIMIT_MS }).catch(() => 0);
    await setWindow(cfg, window, { at: now, resetsAt: limit.resetsAt ?? null, card: id });
    return { status: "sent", id, options: options.map((o) => o.label), line: text };
  } catch (error) {
    await setWindow(cfg, window, null).catch(() => {});
    throw error;
  }
}
