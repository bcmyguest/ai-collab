// Limit alert: one choice card per limit window. Sessions that hit the same typed window share the card. Nothing switches on its own.
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
// A limit with no reset time stays open for this long after its first alert.
export const UNKNOWN_RESET_MS = 5 * 3600_000;
const HANDOFF_FIELD_MAX = 1500;
const ACTIVITY_LIMIT_MS = 1500;
// Model lists come from the cache only: the hook and runner never start a harness CLI to list models.
const noSpawn = async () => "";

const pad = (n) => String(n).padStart(2, "0");

/** "harness:model" when the model is known, else the harness. */
export const who = (harness, model) => (model ? `${harness}:${model}` : harness);

/** Local HH:MM of a reset time (ms), or "" when unknown. */
export function resetClock(resetsAt) {
  if (!Number.isFinite(resetsAt)) return "";
  const at = new Date(resetsAt);
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** "Limit reached" when a window, a reset or limit wording shows a plan limit; a bare HTTP 429 reads "Rate limited". */
export function headlineOf({ windowName, resetsAt, wording }) {
  return windowName || resetsAt || wording ? "Limit reached" : "Rate limited";
}

/** The card's and timeline's line: "Limit reached · claude:claude-opus-5-5 · 5-hour · resets 18:00". */
export function limitLine({ harness, model, windowName, resetsAt, wording = false }) {
  return [headlineOf({ windowName, resetsAt, wording }), who(harness, model), windowName, resetsAt ? `resets ${resetClock(resetsAt)}` : "reset time unknown"]
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

// Session-level alert record: {windows: {<window or "unknown">: {at, expiresAt, card}}}.
function alertsFile(cfg) {
  return statePath(cfg).replace(/\.json$/, ".limits.json");
}

// Project-level index of typed windows: {"<harness>|<window>|<resetsAt>": {card, expiresAt}}.
function indexFile(cfg) {
  return join(cfg.stateDir, cfg.project, "limit-windows.json");
}

// Serializes alert decisions per project, so two sessions cannot publish one window twice.
function lockFile(cfg) {
  return join(cfg.stateDir, cfg.project, "limit-alerts");
}

function readJson(file, pick) {
  try {
    return pick(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return {};
  }
}

const readAlerted = (cfg) => readJson(alertsFile(cfg), (v) => (v && typeof v.windows === "object" ? v.windows : {}));
const readIndex = (cfg) => readJson(indexFile(cfg), (v) => (v && typeof v === "object" ? v : {}));

function writeJson(file, value) {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

const live = (entry, now) => Boolean(entry) && Number.isFinite(entry.expiresAt) && entry.expiresAt > now;

/** The approval-end that closes a limit card: "answered" after a pick, "cancelled" when a later session supersedes it. */
export function limitEndMessage(cfg, id, reason) {
  return encodeEnvelope("approval-end", { from: cfg.peer, id, reason, ts: new Date().toISOString() }, cfg.wire);
}

/** The `fallback` attribute of the pattern role this session runs, or undefined (none, or not in a pattern run). */
export function roleFallback(cfg, address) {
  for (const run of listRuns(cfg)) {
    const role = Object.entries(run.sessions ?? {}).find(([, value]) => value === address)?.[0];
    if (role !== undefined) return run.definition?.roles?.find((item) => item?.id === role)?.fallback;
  }
  return undefined;
}

/** Where the answer handler finds a card's sessions, models and handoff: one JSON file per card. */
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
  writeJson(cardFile(cfg, card.id), card);
}

// A card still offered: not picked, not superseded, not expired.
const cardOpen = (card, now) => Boolean(card) && !card.chosen && !card.superseded && card.expiresAt > now;

const cardText = (card) => limitLine({ harness: card.harness, model: card.model, windowName: card.windowName, resetsAt: card.resetsAt, wording: card.wording });

// One session is named on the card's own line; several sessions get a "Sessions:" line.
function cardSummary(card) {
  const names = card.sessions.map((s) => `${s.peer}#${s.session}`);
  return names.length < 2 ? cardText(card) : `${cardText(card)}\nSessions: ${names.join(", ")}`;
}

function cardMessage(cfg, card) {
  const options = [...card.replacements.map(({ label, description }) => ({ label, ...(description ? { description } : {}) })), { label: WAIT_LABEL }];
  const questions = [{ question: cardText(card), header: headlineOf(card), multiSelect: false, options }];
  const first = card.sessions[0];
  return encodeEnvelope("approval", {
    from: first.peer, session: first.session, harness: card.harness, id: card.id, tool: LIMIT_TOOL, summary: cardSummary(card),
    expiresAt: card.expiresAt, questions, ts: new Date(card.at).toISOString(),
  }, cfg.wire);
}

async function publishCard(cfg, card, { send, env }) {
  const names = card.sessions.map((s) => `${s.peer}#${s.session}`).join(", ");
  await send(cfg, broadcastTopic(cfg.project), cardMessage(cfg, card), {
    title: `${headlineOf(card)} for ${names}`, click: deepLink({ project: cfg.project, session: card.sessions[0].session }), priority: alertPriority(readAlertLevel(env), "question"),
  });
}

/**
 * Publishes the limit for this session. A typed window shared with another session's open card supersedes that card with one that
 * lists both sessions. A session that already has a live alert for this window, or any live untyped alert, is a duplicate.
 * limit is a classifyLimit result (lib/limits.mjs). Returns {status: "sent", id, options, line, sessions} or {status: "duplicate"}.
 */
export async function alertLimit(cfg, { harness, limit, env = process.env, now = Date.now(), send = publish, listed = listModels, available = availableHarnesses, fallback = roleFallback(cfg, `${cfg.peer}#${cfg.session}`) } = {}) {
  const sessionKey = `${cfg.peer}#${cfg.session}`;
  const window = limit.window ?? "unknown";
  const expiresAt = limit.resetsAt ?? now + UNKNOWN_RESET_MS;
  const key = limit.window ? `${harness}|${limit.window}|${limit.resetsAt ?? ""}` : null;
  const decided = await withLock(lockFile(cfg), async () => {
    const mine = readAlerted(cfg);
    // The hook (untyped StopFailure) and the runner (typed rate_limit_event) report one limit: a live alert for the window or an
    // untyped one covers a typed report, and any live alert covers an untyped report.
    const covered = limit.window ? live(mine[window], now) || live(mine.unknown, now) : Object.values(mine).some((e) => live(e, now));
    if (covered) return { status: "duplicate" };
    const index = readIndex(cfg);
    const prior = key && index[key];
    const joining = prior && cardOpen(readCard(cfg, prior.card), now) ? readCard(cfg, prior.card) : null;
    const record = listSessions(cfg).find((s) => s.id === sessionKey) ?? {};
    const member = { peer: cfg.peer, session: cfg.session, model: record.model || "", name: record.name || "", activity: record.activity || "", cwd: record.cwd || "" };
    const id = randomBytes(6).toString("hex");
    let card;
    if (joining) {
      card = { ...joining, id, at: now, sessions: [...joining.sessions, member] };
    } else {
      const models = await listed(cfg.stateDir, env, { peers: cfg.peers, run: noSpawn });
      const replacements = replacementOptions({ harness, model: member.model, fallback, models, available: available(cfg, env) });
      card = {
        id, project: cfg.project, harness, model: member.model, windowName: limit.windowName ?? null, resetsAt: limit.resetsAt ?? null,
        wording: Boolean(limit.wording), expiresAt, at: now, sessions: [member],
        replacements: replacements.map(({ label, harness: h, model: m, description }) => ({ label, harness: h, model: m, ...(description ? { description } : {}) })),
      };
    }
    // The new card goes out before the old one closes, so a failed publish leaves the old card offered.
    await publishCard(cfg, card, { send, env });
    if (joining) {
      await send(cfg, broadcastTopic(cfg.project), limitEndMessage(cfg, joining.id, "cancelled"));
      writeCard(cfg, { ...joining, superseded: id });
    }
    writeCard(cfg, card);
    if (key) writeJson(indexFile(cfg), { ...index, [key]: { card: id, expiresAt: card.expiresAt } });
    writeJson(alertsFile(cfg), { windows: { ...mine, [window]: { at: now, expiresAt, card: id } } });
    await publishActivity(cfg, harness, [{ type: "limit", input: cardText(card) }], { timeoutMs: ACTIVITY_LIMIT_MS }).catch(() => 0);
    return { status: "sent", id, options: [...card.replacements.map((r) => r.label), WAIT_LABEL], line: cardText(card), sessions: card.sessions.length };
  });
  // A busy lock means a concurrent alert may be publishing this window: no second card.
  if (!decided.locked || !decided.value) return { status: "duplicate" };
  return decided.value;
}

/**
 * Acts on the operator's pick for a limit card. "Wait for reset" only acknowledges. A replacement starts a new session for each
 * session on the card, in that session's folder, with the handoff prompt; the original sessions keep running. One pick per card.
 * Returns {status: "waiting" | "started" | "duplicate" | "failed", detail, session?, started?}.
 */
export async function chooseLimit(cfg, { id, label, start = startSession, env = process.env, now = Date.now() } = {}) {
  if (label === WAIT_LABEL) return { status: "waiting", detail: "Waiting for reset" };
  const claim = await withLock(cardFile(cfg, id), () => {
    const card = readCard(cfg, id);
    if (!card) return { problem: "failed", detail: "This limit card is unknown" };
    if (card.chosen) return { problem: "duplicate", detail: "This limit already has an answer" };
    if (!cardOpen(card, now)) return { problem: "failed", detail: "This limit card is closed" };
    const option = card.replacements.find((r) => r.label === label);
    if (!option) return { problem: "failed", detail: "That option is not on this limit card" };
    writeCard(cfg, { ...card, chosen: label, chosenAt: now });
    return { card, option };
  });
  if (!claim.locked) return { status: "failed", detail: "The limit card is busy; try again" };
  if (claim.value.problem) return { status: claim.value.problem, detail: claim.value.detail };
  const { card, option } = claim.value;
  const results = [];
  for (const member of card.sessions) {
    const from = `${member.peer}#${member.session}`;
    const prompt = handoffPrompt({ from, harness: card.harness, model: member.model || card.model, windowName: card.windowName, task: member.name, activity: member.activity });
    const result = await start(cfg, { harness: option.harness, model: option.model, prompt, env, place: "folder" }).catch((error) => ({ status: "failed", detail: error.message }));
    results.push({ from, ...result });
    if (result.status === "started") await linkSessions(cfg, { member, origin: card.harness, option, started: result.session });
  }
  const started = results.filter((r) => r.status === "started");
  if (!started.length) {
    await withLock(cardFile(cfg, id), () => writeCard(cfg, { ...readCard(cfg, id), chosen: undefined, chosenAt: undefined }));
    return { status: "failed", detail: results.map((r) => r.detail).join("; ") };
  }
  await withLock(cardFile(cfg, id), () => writeCard(cfg, { ...readCard(cfg, id), replacedBy: started.map((r) => r.session) }));
  return {
    status: "started", detail: `${started.length} of ${results.length} started`, session: started[0].session,
    started: started.map((r) => ({ from: r.from, session: r.session })), failed: results.filter((r) => r.status !== "started").map((r) => ({ from: r.from, detail: r.detail })),
  };
}

// Each session's timeline links to its replacement: the original gets the new session, the new session its origin.
async function linkSessions(cfg, { member, origin, option, started }) {
  const [newPeer, newLabel] = started.split("#");
  await publishActivity({ ...cfg, peer: member.peer, session: member.session }, origin, [{ type: "handoff", input: `Replacement started: ${started}` }], { timeoutMs: ACTIVITY_LIMIT_MS }).catch(() => 0);
  await publishActivity({ ...cfg, peer: newPeer, session: newLabel }, option.harness, [{ type: "handoff", input: `Continues ${member.peer}#${member.session} after a limit` }], { timeoutMs: ACTIVITY_LIMIT_MS }).catch(() => 0);
}
