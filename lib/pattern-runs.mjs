/**
 * Pattern runs: one run per `pattern start`. Each run keeps its active role, the session per role, and the handoff log.
 * The runtime refuses a run's completion until every required handoff has fired, and fails a run when a capped handoff fires past its cap.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sendMessage } from "./inbox.mjs";
import { DONE, getPattern, requiredHandoffs, validatePatternModels } from "./patterns.mjs";
import { checkPrompt, startSession } from "./start.mjs";
import { withLock, writeState } from "./state.mjs";

export const RUN_ID = /^[a-z0-9]{6,32}$/;
export const NOTE_MAX = 1000;

function runsDir(cfg) {
  return join(cfg.stateDir, cfg.project, "pattern-runs");
}

function runFile(cfg, id) {
  if (!RUN_ID.test(String(id))) throw new Error(`invalid run id "${id}"`);
  return join(runsDir(cfg), `${id}.json`);
}

function readRunFile(file, id) {
  let value;
  try { value = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error(`unknown run "${id}"`); }
  if (!value || typeof value !== "object") throw new Error(`unknown run "${id}"`);
  return value;
}

/** Read-modify-write under the run's lock; fn returns { run, ...extra } and the run is saved. */
async function updateRun(cfg, id, fn) {
  const file = runFile(cfg, id);
  mkdirSync(runsDir(cfg), { recursive: true, mode: 0o700 });
  const locked = await withLock(file, async () => {
    const next = fn(readRunFile(file, id));
    writeState(file, next.run);
    return next;
  }, { waitMs: 5000 });
  if (!locked.locked) throw new Error(`run "${id}" is busy; retry`);
  return locked.value;
}

const sameHandoff = (a, b) => a.from === b.from && a.to === b.to && a.on === b.on;

const describeHandoff = (handoff) => `"${handoff.on}" ${handoff.from} -> ${handoff.to}`;

function roleBrief(pattern, run, role, arrival) {
  const events = pattern.handoffs.filter((handoff) => handoff.from === role.id)
    .map((handoff) => `"${handoff.on}" -> ${handoff.to}${handoff.required ? " (required)" : ""}`);
  const lines = [
    `Pattern "${pattern.name}" run ${run.id}, role "${role.id}".`,
    `Responsibility: ${role.responsibility}`,
    `Task: ${run.task}`,
  ];
  if (arrival) lines.push(`Handed to you from ${arrival.from} on "${arrival.on}".`);
  if (arrival?.note) lines.push(`Note: ${arrival.note}`);
  lines.push(`When your part is done, run: ai-collab pattern advance ${run.id} "<event>" ["note"]`);
  lines.push(`Events you can send: ${events.length ? events.join("; ") : "none"}`);
  return lines.join("\n");
}

function newRunId() {
  return `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

/** Starts the role session for a role; resolves the start result. */
async function launchRole(cfg, pattern, run, role, env, start, arrival) {
  const checked = checkPrompt(roleBrief(pattern, run, role, arrival));
  if (checked.error) throw new Error(checked.error);
  return start(cfg, {
    harness: role.harness, prompt: checked.text, env, place: "folder", ...(role.model ? { model: role.model } : {}),
  });
}

export async function startRun(cfg, name, task, env = process.env, { start = startSession, models, now = Date.now } = {}) {
  const pattern = getPattern(cfg, name, env);
  if (pattern.legacy) throw new Error(`"${name}" is a team; use team start`);
  const checked = checkPrompt(task);
  if (checked.error) throw new Error(checked.error);
  await validatePatternModels(pattern, cfg, env, models);
  const entry = pattern.roles[0];
  const run = {
    id: newRunId(), pattern: name, task: checked.text, status: "running", active: entry.id,
    sessions: {}, handoffs: [], startedAt: now(),
  };
  mkdirSync(runsDir(cfg), { recursive: true, mode: 0o700 });
  writeState(runFile(cfg, run.id), run);
  const result = await launchRole(cfg, pattern, run, entry, env, start);
  if (result.status === "failed") {
    run.status = "failed";
    run.error = result.detail;
    writeState(runFile(cfg, run.id), run);
    return { id: run.id, status: "failed", active: entry.id, detail: result.detail };
  }
  if (typeof result.session === "string") run.sessions[entry.id] = result.session;
  writeState(runFile(cfg, run.id), run);
  return { id: run.id, status: "running", active: entry.id, session: result.session, detail: result.detail };
}

export async function advanceRun(cfg, id, event, { note = "", env = process.env, start = startSession, now = Date.now } = {}) {
  const current = readRunFile(runFile(cfg, id), id);
  const pattern = getPattern(cfg, current.pattern, env);
  const on = String(event ?? "").trim();
  const trimmed = String(note ?? "").trim().slice(0, NOTE_MAX);
  const decided = await updateRun(cfg, id, (run) => {
    if (run.status !== "running") throw new Error(`run ${id} is ${run.status}`);
    const handoff = pattern.handoffs.find((item) => item.from === run.active && item.on === on);
    if (!handoff) {
      const allowed = pattern.handoffs.filter((item) => item.from === run.active).map((item) => `"${item.on}"`);
      throw new Error(`no handoff "${on}" from ${run.active}; allowed: ${allowed.join(", ") || "none"}`);
    }
    if (handoff.to === DONE) {
      const missing = requiredHandoffs(pattern).filter((req) => !run.handoffs.some((item) => sameHandoff(item, req)));
      if (missing.length) throw new Error(`run cannot finish: required handoff not done: ${missing.map(describeHandoff).join("; ")}`);
      run.status = "done";
      run.handoffs.push({ seq: run.handoffs.length + 1, at: now(), from: handoff.from, to: DONE, on, note: trimmed });
      return { run, handoff, deliver: false };
    }
    if (handoff.cap !== undefined && run.handoffs.filter((item) => sameHandoff(item, handoff)).length >= handoff.cap) {
      run.status = "failed";
      run.error = `"${on}" reached its cap of ${handoff.cap} rounds`;
      return { run, handoff, deliver: false };
    }
    const record = { seq: run.handoffs.length + 1, at: now(), from: handoff.from, to: handoff.to, on, note: trimmed };
    run.handoffs.push(record);
    run.active = handoff.to;
    return { run, handoff, record, deliver: true };
  });
  if (!decided.deliver) return { id, status: decided.run.status, active: decided.run.active, detail: decided.run.error ?? "run done" };
  const { run: after, handoff, record } = decided;
  const role = pattern.roles.find((item) => item.id === handoff.to);
  const arrival = { from: handoff.from, on, note: trimmed };
  const address = after.sessions[role.id];
  let detail;
  if (address) {
    try {
      await sendMessage(cfg, address, roleBrief(pattern, after, role, arrival));
      detail = `handed to ${address}`;
    } catch (error) {
      detail = `recorded; message to ${address} failed: ${error.message}`;
    }
    return { id, status: "running", active: role.id, handoff: record, detail };
  }
  const result = await launchRole(cfg, pattern, after, role, env, start, arrival);
  await updateRun(cfg, id, (run) => {
    if (result.status === "failed") { run.status = "failed"; run.error = result.detail; }
    else if (typeof result.session === "string") run.sessions[role.id] = result.session;
    return { run };
  });
  detail = result.detail;
  return { id, status: result.status === "failed" ? "failed" : "running", active: role.id, handoff: record, session: result.session, detail };
}

export function runStatus(cfg, id) {
  return readRunFile(runFile(cfg, id), id);
}

export function listRuns(cfg) {
  let names;
  try { names = readdirSync(runsDir(cfg)); } catch { return []; }
  return names.filter((name) => name.endsWith(".json") && RUN_ID.test(name.slice(0, -5)))
    .map((name) => readRunFile(join(runsDir(cfg), name), name.slice(0, -5)))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}
