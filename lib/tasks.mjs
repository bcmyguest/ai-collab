/**
 * Project task list. Source of truth: <project root>/.ai-collab/tasks.json ({"v": 1, "tasks": [...]}).
 * docs/feature-requests.md is rendered from it. A missing file reads as no tasks; an invalid file throws.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isValidName, listProjects } from "./config.mjs";
import { withLock } from "./state.mjs";

export const STATUSES = ["open", "decided", "building", "blocked", "done"];
export const TASKS_VERSION = 1;
export const ID_MAX = 40;
export const TITLE_MAX = 200;
export const DETAIL_MAX = 2000;
export const PROGRESS_MAX = 500;
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RUN_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const OWNER_RE = /^([a-z0-9-]{1,24})#([a-f0-9]{16})$/;
const DOC_HEADER = `# Feature requests

Operator requests from chat and the terminal, newest last. Status: ${STATUSES.join(", ")}.

Generated from .ai-collab/tasks.json by \`ai-collab task render\`. Change tasks with \`ai-collab task\`, not this file.

| Request | Status |
|---|---|
`;

export function tasksFile(root) {
  return join(root, ".ai-collab", "tasks.json");
}

export function featureRequestsFile(root) {
  return join(root, "docs", "feature-requests.md");
}

function taskError(id, message) {
  return new Error(`task ${id}: ${message}`);
}

function checkTask(t) {
  const id = typeof t?.id === "string" ? t.id : "?";
  if (!t || typeof t !== "object" || Array.isArray(t)) throw taskError(id, "not an object");
  if (typeof t.id !== "string" || !ID_RE.test(t.id) || t.id.length > ID_MAX) throw taskError(id, "invalid id");
  if (typeof t.title !== "string" || !t.title.trim() || t.title.length > TITLE_MAX) throw taskError(id, "invalid title");
  if (!STATUSES.includes(t.status)) throw taskError(id, `invalid status ${JSON.stringify(t.status)}`);
  if (t.detail !== undefined && (typeof t.detail !== "string" || t.detail.length > DETAIL_MAX)) throw taskError(id, "invalid detail");
  if (!Array.isArray(t.blockers) || t.blockers.some((b) => typeof b !== "string") || new Set(t.blockers).size !== t.blockers.length) {
    throw taskError(id, "blockers must be unique task ids");
  }
  if (t.owner !== undefined) {
    const match = typeof t.owner === "string" ? OWNER_RE.exec(t.owner) : null;
    if (!match || !isValidName(match[1])) throw taskError(id, "owner must be a session address like claude#0123456789abcdef");
  }
  if (t.run !== undefined && (typeof t.run !== "string" || !RUN_RE.test(t.run))) throw taskError(id, "invalid run id");
  if (!Array.isArray(t.progress) || t.progress.some((p) => !p || typeof p !== "object"
    || !Number.isFinite(p.at) || typeof p.by !== "string" || !p.by
    || typeof p.text !== "string" || !p.text.trim() || p.text.length > PROGRESS_MAX)) {
    throw taskError(id, "progress must be entries of {at, by, text}");
  }
  if (!Number.isFinite(t.created) || !Number.isFinite(t.updated)) throw taskError(id, "created and updated must be timestamps");
}

// Depth-first search over blocker edges; a back edge is a cycle.
function assertAcyclic(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "active") throw taskError(id, "blocker cycle");
    state.set(id, "active");
    for (const b of byId.get(id).blockers) visit(b);
    state.set(id, "done");
  };
  for (const t of tasks) visit(t.id);
}

/** Checks a whole task document and returns it; throws on the first problem. */
export function validateTasks(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || doc.v !== TASKS_VERSION || !Array.isArray(doc.tasks)) {
    throw new Error(`expected {"v": ${TASKS_VERSION}, "tasks": []}`);
  }
  const ids = new Set();
  for (const t of doc.tasks) {
    checkTask(t);
    if (ids.has(t.id)) throw taskError(t.id, "duplicate id");
    ids.add(t.id);
  }
  for (const t of doc.tasks) {
    for (const b of t.blockers) {
      if (b === t.id) throw taskError(t.id, "blocks itself");
      if (!ids.has(b)) throw taskError(t.id, `blocker ${b} is not a task`);
    }
  }
  assertAcyclic(doc.tasks);
  return doc;
}

export function readTasks(root) {
  const file = tasksFile(root);
  if (!existsSync(file)) return { v: TASKS_VERSION, tasks: [] };
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file}: invalid JSON: ${err.message}`);
  }
  try {
    return validateTasks(doc);
  } catch (err) {
    throw new Error(`${file}: ${err.message}`);
  }
}

/** Validates, then writes through a temp file and rename so readers never see a partial file. */
export function writeTasks(root, doc) {
  validateTasks(doc);
  const file = tasksFile(root);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(tmp, file);
  return doc;
}

/** A lowercase slug of at most ID_MAX chars; "task" when the title has no letters or digits. */
export function slugify(title) {
  const slug = String(title).toLowerCase().replace(/[`'"]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, ID_MAX).replace(/-+$/, "") || "task";
}

function uniqueId(doc, base) {
  const taken = new Set(doc.tasks.map((t) => t.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base.slice(0, ID_MAX - String(n).length - 1).replace(/-+$/, "")}-${n}`;
    if (!taken.has(id)) return id;
  }
}

function findTask(doc, id) {
  const task = doc.tasks.find((t) => t.id === id);
  if (!task) throw new Error(`no task ${id}`);
  return task;
}

/** Adds a task with status open unless given; the id defaults to a slug of the title. Returns the task. */
export function addTask(doc, { id, title, detail, status = "open" }, now = Date.now()) {
  const text = String(title ?? "").trim();
  const taskId = id ?? uniqueId(doc, slugify(text));
  if (doc.tasks.some((t) => t.id === taskId)) throw new Error(`task ${taskId} exists`);
  const task = { id: taskId, title: text, status, ...(detail ? { detail } : {}), blockers: [], progress: [], created: now, updated: now };
  doc.tasks.push(task);
  return task;
}

export function setTaskField(doc, id, field, value, now = Date.now()) {
  const task = findTask(doc, id);
  if (field === "status" && !STATUSES.includes(value)) throw new Error(`invalid status ${value}`);
  if (field !== "status" && field !== "title" && field !== "detail") throw new Error(`cannot set ${field}`);
  task[field] = value;
  task.updated = now;
  return task;
}

/** Records that task `id` is blocked on task `on`. */
export function blockTask(doc, id, on, now = Date.now()) {
  const task = findTask(doc, id);
  if (!task.blockers.includes(on)) task.blockers.push(on);
  task.updated = now;
  return task;
}

export function ownTask(doc, id, address, now = Date.now()) {
  const task = findTask(doc, id);
  task.owner = address;
  task.updated = now;
  return task;
}

/** Appends the text to every building task that address owns; returns how many. Stores nothing without a task file. */
export async function recordOwnerProgress(cfg, text, env = process.env, now = Date.now()) {
  const address = cfg.session && cfg.peer ? `${cfg.peer}#${cfg.session}` : "";
  const root = cfg.root || listProjects(env).find((p) => p.project === cfg.project)?.root;
  if (!address || !root || !existsSync(tasksFile(root))) return 0;
  const result = await withLock(tasksFile(root), () => {
    const doc = readTasks(root);
    const owned = doc.tasks.filter((t) => t.owner === address && t.status === "building");
    for (const task of owned) addProgress(doc, task.id, { by: address, text }, now);
    if (owned.length) writeTasks(root, doc);
    return owned.length;
  });
  return result.value ?? 0;
}

export function addProgress(doc, id, { by, text }, now = Date.now()) {
  const task = findTask(doc, id);
  task.progress.push({ at: now, by, text: String(text).trim() });
  task.updated = now;
  return task;
}

// Status cell: "done (merged)" → status done, detail "(merged)"; a first word that is no status keeps the whole cell as detail under open.
function parseStatusCell(cell) {
  const m = /^([A-Za-z]+)\b\s*([\s\S]*)$/.exec(cell.trim());
  const word = m?.[1].toLowerCase();
  if (word && STATUSES.includes(word)) return { status: word, detail: m[2].trim() };
  return { status: "open", detail: cell.trim() };
}

function splitRow(line) {
  return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** Converts the Request | Status table of feature-requests.md into tasks, in table order. */
export function importFeatureRequests(markdown, now = Date.now()) {
  const doc = { v: TASKS_VERSION, tasks: [] };
  for (const line of markdown.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const [title, statusCell, ...extra] = splitRow(line);
    if (extra.length || statusCell === undefined) throw new Error(`expected two cells: ${line}`);
    if (title === "Request" || /^:?-+:?$/.test(title)) continue;
    const { status, detail } = parseStatusCell(statusCell);
    addTask(doc, { title, status, detail: detail || undefined }, now);
  }
  return validateTasks(doc);
}

const cell = (text) => String(text).replace(/\|/g, "\\|");

function statusCell(task) {
  const detail = task.detail ?? "";
  if (!detail) return task.status;
  return `${task.status}${/^[;:,]/.test(detail) ? "" : " "}${detail}`;
}

/** The feature-requests.md text for a task document: the same Request | Status table layout. */
export function renderFeatureRequests(doc) {
  const rows = doc.tasks.map((t) => `| ${cell(t.title)} | ${cell(statusCell(t))} |\n`);
  return `${DOC_HEADER}${rows.join("")}`;
}
