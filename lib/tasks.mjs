/**
 * Project task list. The default backend is a file outside git: <XDG_DATA_HOME or ~/.local/share>/ai-collab/tasks/<project>.json
 * ({"v": 1, "tasks": [...]}), shared by every checkout. docs/feature-requests.md is a committed snapshot rendered from it.
 * A missing file reads as no tasks; an invalid file throws. Writes lock, validate, then rename a temp file over the store.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BRANCH_NAME, COMMIT_ID, REVIEW_FILES_MAX, REVIEW_PATH_MAX, changeSummary, reviewIsCurrent } from "./build-review.mjs";
import { isValidName, listProjects } from "./config.mjs";
import { RUN_ID } from "./pattern-runs.mjs";
import { withLock } from "./state.mjs";
import { TASK_PRIORITY_DEFAULT, TASK_PRIORITIES, priorityOf, sortTasks } from "./task-order.mjs";

export { TASK_PRIORITIES, TASK_PRIORITY_DEFAULT, priorityOf, sortTasks };
export const STATUSES = ["open", "decided", "building", "review", "blocked", "done"];
/** The statuses a review decision moves a task to: accept finishes it, return queues it for another build. */
export const REVIEW_ACTIONS = ["accept", "return"];
const REVIEW_RESULT = { accept: "done", return: "decided" };
export const BACKENDS = ["file"];
export const BACKEND_DEFAULT = "file";
export const TASKS_VERSION = 1;
export const ID_MAX = 40;
export const TITLE_MAX = 300;
export const DETAIL_MAX = 2000;
export const PROGRESS_MAX = 500;
export const QUESTION_MAX = 500;
export const OPTION_MAX = 80;
export const OPTIONS_MAX = 6;
export const TABLE_START = "<!-- tasks:start -->";
export const TABLE_END = "<!-- tasks:end -->";
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OWNER_RE = /^([a-z0-9-]{1,24})#([a-f0-9]{16})$/;
const LINE_BREAK = /[\r\n]/;
// A status word must end the cell or precede a separator; "building-ish" is no status.
// A status word, case-insensitive, then the end, a space or punctuation, or a dash set off by spaces; "open-ended" is no status.
const STATUS_CELL = /^(open|decided|building|review|blocked|done)(?=$|[\s;:,(—]|\s+-(?=\s|$))/i;
const DOC_PROSE = `# Feature requests

Operator requests from chat and the terminal, newest last. Status: ${STATUSES.join(", ")} (the UI shows decided as Ready). Priority: ${TASK_PRIORITIES.join(", ")}; a missing priority is ${TASK_PRIORITY_DEFAULT}. Rows are sorted by priority, then status, then most recently updated.

Generated from the task store by \`ai-collab task render\`. Change tasks with \`ai-collab task\`, not this file.

`;
const TABLE_HEAD = "| Request | Priority | Status |\n|---|---|---|\n";

export function taskStoreDir(env = process.env) {
  return join(env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share"), "ai-collab", "tasks");
}

export function taskStoreFile(project, env = process.env) {
  return join(taskStoreDir(env), `${project}.json`);
}

function taskError(id, message) {
  return new Error(`task ${id}: ${message}`);
}

function codePoints(text) {
  return [...text].length;
}

function checkTask(t) {
  const id = typeof t?.id === "string" ? t.id : "?";
  if (!t || typeof t !== "object" || Array.isArray(t)) throw taskError(id, "not an object");
  if (typeof t.id !== "string" || !ID_RE.test(t.id) || t.id.length > ID_MAX) throw taskError(id, "invalid id");
  if (typeof t.title !== "string" || !t.title.trim() || t.title.length > TITLE_MAX || LINE_BREAK.test(t.title)) throw taskError(id, "invalid title");
  if (!STATUSES.includes(t.status)) throw taskError(id, `invalid status ${JSON.stringify(t.status)}`);
  if (t.priority !== undefined && !TASK_PRIORITIES.includes(t.priority)) throw taskError(id, `invalid priority ${JSON.stringify(t.priority)}`);
  if (t.detail !== undefined && (typeof t.detail !== "string" || t.detail.length > DETAIL_MAX || LINE_BREAK.test(t.detail))) throw taskError(id, "invalid detail");
  if (!Array.isArray(t.blockers) || t.blockers.some((b) => typeof b !== "string") || new Set(t.blockers).size !== t.blockers.length) {
    throw taskError(id, "blockers must be unique task ids");
  }
  if (t.owner !== undefined) {
    const match = typeof t.owner === "string" ? OWNER_RE.exec(t.owner) : null;
    if (!match || !isValidName(match[1])) throw taskError(id, "owner must be a session address like claude#0123456789abcdef");
  }
  if (t.run !== undefined && (typeof t.run !== "string" || !RUN_ID.test(t.run))) throw taskError(id, "invalid run id");
  if (!Array.isArray(t.progress) || t.progress.some((p) => !p || typeof p !== "object"
    || !Number.isFinite(p.at) || typeof p.by !== "string" || !p.by
    || typeof p.text !== "string" || !p.text.trim() || codePoints(p.text) > PROGRESS_MAX)) {
    throw taskError(id, "progress must be entries of {at, by, text}");
  }
  if (t.review !== undefined) checkReview(id, t.review);
  if (t.question !== undefined) checkQuestion(id, t.question);
  if (!Number.isFinite(t.created) || !Number.isFinite(t.updated)) throw taskError(id, "created and updated must be timestamps");
}

const oneLine = (text, max) => typeof text === "string" && text.trim() && codePoints(text) <= max && !LINE_BREAK.test(text);

// A build review packet: the submitted commit, what it was asked to do, the host check, and the decision once made.
function checkReview(id, r) {
  const count = (value) => Number.isInteger(value) && value >= 0;
  const files = Array.isArray(r?.files) && r.files.length <= REVIEW_FILES_MAX && r.files.every((file) =>
    file && typeof file.path === "string" && file.path && codePoints(file.path) <= REVIEW_PATH_MAX && !LINE_BREAK.test(file.path)
    && count(file.insertions) && count(file.deletions));
  if (!r || typeof r !== "object" || Array.isArray(r)
    || typeof r.commit !== "string" || !COMMIT_ID.test(r.commit)
    || typeof r.base !== "string" || !COMMIT_ID.test(r.base)
    || typeof r.branch !== "string" || !BRANCH_NAME.test(r.branch)
    || typeof r.submission !== "string" || !r.submission || codePoints(r.submission) > 64 || LINE_BREAK.test(r.submission)
    || typeof r.criteria !== "string" || codePoints(r.criteria) > DETAIL_MAX
    || !r.check || !Number.isInteger(r.check.code) || typeof r.check.text !== "string" || codePoints(r.check.text) > PROGRESS_MAX
    || !files || !count(r.insertions) || !count(r.deletions) || !count(r.more) || !Number.isFinite(r.at)) {
    throw taskError(id, "invalid build review packet");
  }
  const d = r.decision;
  if (d !== undefined && (!d || typeof d !== "object" || Array.isArray(d) || !REVIEW_ACTIONS.includes(d.action)
    || !Number.isFinite(d.at) || !oneLine(d.by, PROGRESS_MAX)
    || (d.action === "return" ? !oneLine(d.note, PROGRESS_MAX) : d.note !== undefined))) {
    throw taskError(id, "invalid build review decision");
  }
}

// A question for the operator: {text, by, at, options?}; once answered it also holds answer {text, by, at}.
function checkQuestion(id, q) {
  if (!q || typeof q !== "object" || Array.isArray(q) || !oneLine(q.text, QUESTION_MAX) || typeof q.by !== "string" || !q.by || !Number.isFinite(q.at)) {
    throw taskError(id, "question must be {text, by, at} with one line of text");
  }
  if (q.options !== undefined && (!Array.isArray(q.options) || q.options.length > OPTIONS_MAX || q.options.some((o) => !oneLine(o, OPTION_MAX)))) {
    throw taskError(id, `question options must be at most ${OPTIONS_MAX} one-line choices`);
  }
  const a = q.answer;
  if (a !== undefined && (!a || typeof a !== "object" || !oneLine(a.text, QUESTION_MAX) || typeof a.by !== "string" || !a.by || !Number.isFinite(a.at))) {
    throw taskError(id, "answer must be {text, by, at} with one line of text");
  }
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

function outcomeStep(doc, action, { id, outcome, check, titles, result, passed, by, revision }) {
  const outcomes = doc.outcomes ??= [];
  if (action === "request") {
    if (!oneLine(outcome, 500) || !oneLine(check, 500)) throw new Error("Give an outcome and one acceptance check (up to 500 characters each)");
    const entry = { id: randomUUID(), outcome: outcome.trim(), check: check.trim(), state: "requested" };
    outcomes.push(entry);
    return entry;
  }

  const entry = outcomes.find(item => item.id === id);
  if (!entry) throw new Error("Unknown outcome");
  if (action === "propose" && entry.state === "requested") {
    if (!Array.isArray(titles) || titles.length < 1 || titles.length > 3
      || titles.some(title => !oneLine(title, TITLE_MAX) || title.length > TITLE_MAX)
      || new Set(titles.map(title => title.trim())).size !== titles.length) {
      throw new Error("Propose one to three distinct task titles");
    }
    entry.titles = titles.map(title => title.trim());
    entry.state = "proposed";
  } else if (action === "approve" && entry.state === "proposed") {
    entry.taskIds = entry.titles.map(title => addTask(doc, {
      title, status: "decided", detail: "Outcome: " + entry.outcome + " | Acceptance check: " + entry.check,
    }).id);
    entry.state = "approved";
  } else if (["report", "accept"].includes(action) && entry.state === "approved") {
    if (!entry.taskIds.every(taskId => findTask(doc, taskId).status === "done")) throw new Error("Finish every linked task first");
    if (action === "report") {
      if (!oneLine(result, 500) || typeof passed !== "boolean") throw new Error("Give a pass or fail result and evidence (up to 500 characters)");
      entry.result = { text: result.trim(), passed, by, revision: randomUUID() };
    } else {
      if (!entry.result?.passed || entry.result.revision !== revision) throw new Error("Review the current passing acceptance result first");
      entry.state = "closed";
    }
  } else {
    throw new Error("This outcome action is unavailable in its current state");
  }
  return entry;
}

export function readStore(file) {
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
export function writeStore(file, doc) {
  validateTasks(doc);
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
export function addTask(doc, { id, title, detail, status = "open", priority }, now = Date.now()) {
  const text = String(title ?? "").trim();
  const taskId = id ?? uniqueId(doc, slugify(text));
  if (doc.tasks.some((t) => t.id === taskId)) throw new Error(`task ${taskId} exists`);
  const task = { id: taskId, title: text, status, ...(priority ? { priority } : {}), ...(detail ? { detail } : {}), blockers: [], progress: [], created: now, updated: now };
  doc.tasks.push(task);
  validateTasks(doc);
  return task;
}

export function setTaskField(doc, id, field, value, now = Date.now()) {
  const task = findTask(doc, id);
  if (!["status", "title", "detail", "run", "priority"].includes(field)) throw new Error(`cannot set ${field}`);
  if (field === "status" && !STATUSES.includes(value)) throw new Error(`invalid status ${value}`);
  if (field === "priority" && !TASK_PRIORITIES.includes(value)) throw new Error(`invalid priority ${value}`);
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

/** Removes a task; refuses while another task still lists it as a blocker, naming those tasks. Returns the task. */
export function removeTask(doc, id) {
  const task = findTask(doc, id);
  if (doc.outcomes?.some(entry => entry.taskIds?.includes(id))) throw taskError(id, "linked to a project outcome");
  const dependents = doc.tasks.filter((t) => t.blockers.includes(id)).map((t) => t.id);
  if (dependents.length) throw taskError(id, `blocked on by ${dependents.join(", ")}; unblock them first`);
  doc.tasks.splice(doc.tasks.indexOf(task), 1);
  validateTasks(doc);
  return task;
}

/** A progress text trimmed to PROGRESS_MAX code points; truncated says whether an ellipsis replaced the tail. */
export function clipProgress(text) {
  const clean = String(text).trim();
  const chars = [...clean];
  if (chars.length <= PROGRESS_MAX) return { text: clean, truncated: false };
  return { text: `${chars.slice(0, PROGRESS_MAX - 1).join("")}…`, truncated: true };
}

export function addProgress(doc, id, { by, text }, now = Date.now()) {
  const task = findTask(doc, id);
  task.progress.push({ at: now, by, text: clipProgress(text).text });
  task.updated = now;
  return task;
}

/**
 * A review packet from the pieces a builder has: the Git range, the task's criteria, the host check and the numstat.
 * `submission` changes on every run, so a re-run's decision cannot land on the earlier packet.
 */
export function reviewPacket({ commit, base, branch, criteria, check, numstat, submission, at = Date.now() }) {
  return {
    submission, commit, base, branch,
    criteria: clipProgress(criteria ?? "").text,
    check: { code: Number.isInteger(check?.code) ? check.code : 2, text: clipProgress(check?.text ?? "").text },
    ...changeSummary(numstat),
    at,
  };
}

/** Records a completed build for review: the task moves to `review` with the packet beside it. */
export function submitReview(doc, id, packet, now = Date.now()) {
  const next = { ...packet, at: Number.isFinite(packet?.at) ? packet.at : now };
  checkReview(id, next);
  const task = setTaskField(doc, id, "status", "review", now);
  task.review = next;
  return task;
}

/**
 * Attaches a packet for a task the same write already moved to `review`. A settlement publishes status and packet in
 * one patch, so the task needs a setter that takes both; the packet is validated exactly as submitReview does.
 */
function setReview(doc, id, packet, now) {
  const task = findTask(doc, id);
  if (packet === null) {
    delete task.review;
  } else {
    const next = { ...packet, at: Number.isFinite(packet?.at) ? packet.at : now };
    checkReview(id, next);
    task.review = next;
  }
  task.updated = now;
  return task;
}

/**
 * Accept or return the pending packet. Throws for an unknown packet, one the branch has moved past, and a task that is
 * no longer in review. Accept marks the task done for that commit; return queues it again with the operator's note.
 */
export function decideReview(doc, id, { commit, submission, action, note, by, root, landedAnswer }, now = Date.now()) {
  const task = findTask(doc, id);
  const review = task.review;
  if (!review || review.commit !== commit || review.submission !== submission) throw taskError(id, "review packet is stale");
  // The merge CLI has already verified this exact commit on origin for a landed review.
  const landed = action === "accept" && landedAnswer;
  if (!landed && !reviewIsCurrent(root, review)) throw taskError(id, "the build branch moved past the submitted commit");
  if (task.status !== "review" || review.decision) throw taskError(id, "review is no longer pending");
  if (!REVIEW_ACTIONS.includes(action)) throw taskError(id, "unknown review action");
  const text = String(note ?? "").trim();
  if (action === "return" && !oneLine(text, PROGRESS_MAX)) throw taskError(id, "Give a one-line return note up to 500 characters");
  review.decision = { action, at: now, by, ...(action === "return" ? { note: text } : {}) };
  setTaskField(doc, id, "status", REVIEW_RESULT[action], now);
  const answer = task.question?.answer;
  if (landed && answer?.at === landedAnswer.at && answer?.by === landedAnswer.by && answer?.text === landedAnswer.text) {
    delete task.question;
  }
  addProgress(doc, id, { by, text: action === "accept" ? `Build accepted at ${review.commit.slice(0, 12)}` : `Build returned: ${text}` }, now);
  return task;
}

/** Puts a question for the operator on a task, replacing any earlier one and its answer; null removes it. */
export function askTask(doc, id, question, now = Date.now()) {
  const task = findTask(doc, id);
  if (question === null) {
    delete task.question;
  } else {
    const text = String(question?.text ?? "").trim();
    const options = (question?.options ?? []).map((o) => String(o).trim()).filter(Boolean);
    task.question = { text, by: question?.by, at: now, ...(options.length ? { options } : {}) };
  }
  task.updated = now;
  return task;
}

/** Records the operator's answer to a task's open question, plus a progress line, so the next agent run reads it. */
export function answerTask(doc, id, { text, by }, now = Date.now()) {
  const task = findTask(doc, id);
  if (!task.question) throw taskError(id, "has no question to answer");
  const answer = String(text ?? "").trim();
  task.question.answer = { text: answer, by, at: now };
  task.progress.push({ at: now, by, text: clipProgress(`Decision: ${answer}`).text });
  task.updated = now;
  return task;
}

/** A task waits on the operator while it has a question with no answer. */
export const needsDecision = (task) => Boolean(task.question && !task.question.answer);

// Applies a patch of { status, title, detail, run, priority, owner, block, review, progress: {by, text}, ask, answer } to one task.
function applyPatch(doc, id, patch, now) {
  const setters = {
    status: (value) => setTaskField(doc, id, "status", value, now),
    title: (value) => setTaskField(doc, id, "title", value, now),
    detail: (value) => setTaskField(doc, id, "detail", value, now),
    run: (value) => setTaskField(doc, id, "run", value, now),
    priority: (value) => setTaskField(doc, id, "priority", value, now),
    owner: (value) => ownTask(doc, id, value, now),
    block: (value) => blockTask(doc, id, value, now),
    review: (value) => setReview(doc, id, value, now),
    progress: (value) => addProgress(doc, id, value, now),
    ask: (value) => askTask(doc, id, value, now),
    answer: (value) => answerTask(doc, id, value, now),
  };
  for (const [key, value] of Object.entries(patch)) {
    if (!setters[key]) throw new Error(`cannot set ${key}`);
    setters[key](value);
  }
  return findTask(doc, id);
}

/**
 * The file backend: list and get read the store; add, update, addProgress, remove, submitReview and decideReview write
 * under the store lock. A future backend (GitHub Issues, Linear) implements the same methods.
 */
export function createFileBackend(file) {
  const busy = () => new Error("task store is busy; retry");
  const mutate = async (change, lockOptions) => {
    const result = await withLock(file, async () => {
      const doc = readStore(file);
      const value = change(doc);
      writeStore(file, doc);
      return value;
    }, lockOptions);
    if (!result.locked) throw busy();
    return result.value;
  };
  return {
    file,
    /** Calls onChange when the store file changes, polled once a second; returns the function that stops it. */
    watch(onChange) {
      watchFile(file, { interval: 1000, persistent: false }, onChange);
      return () => unwatchFile(file, onChange);
    },
    list: () => readStore(file).tasks,
    projectBoard: () => readStore(file),
    outcome: (action, fields) => mutate(doc => outcomeStep(doc, action, fields)),
    get(id) {
      const task = readStore(file).tasks.find((t) => t.id === id);
      if (!task) throw new Error(`no task ${id}`);
      return task;
    },
    add: (fields, now = Date.now()) => mutate((doc) => addTask(doc, fields, now)),
    update: (id, patch, now = Date.now(), lockOptions) => mutate((doc) => applyPatch(doc, id, patch, now), lockOptions),
    addProgress: (id, entry, now = Date.now()) => mutate((doc) => addProgress(doc, id, entry, now)),
    /** Records a completed build for review: the task moves to `review` with the packet beside it. */
    submitReview: (id, packet, now = Date.now()) => mutate((doc) => submitReview(doc, id, packet, now)),
    /**
     * Accept or return the pending packet. Refuses a stale packet (the commit or submission is not the one on the task,
     * or the branch has moved), a task that is no longer in review, and a return with no note.
     */
    decideReview: (id, decision, now = Date.now()) => mutate((doc) => decideReview(doc, id, decision, now)),
    remove: (id) => mutate((doc) => removeTask(doc, id)),
    /** Writes a whole document into an empty store; refuses when the store file exists. */
    async replaceAll(next) {
      const result = await withLock(file, async () => {
        if (existsSync(file)) throw new Error(`${file} exists; import runs once`);
        writeStore(file, validateTasks(next));
        return next.tasks.length;
      });
      if (!result.locked) throw busy();
      return result.value;
    },
  };
}

/** The backend a project uses: projects.json "tasks" (default "file"). Throws on an unknown name. */
export function openTasks(project, env = process.env) {
  if (!isValidName(project)) throw new Error(`invalid project name ${project}`);
  const entry = listProjects(env).find((p) => p.project === project);
  const name = entry?.tasks ?? BACKEND_DEFAULT;
  if (!BACKENDS.includes(name)) throw new Error(`unknown tasks backend ${name}`);
  return createFileBackend(taskStoreFile(project, env));
}

// Status cell: a status word, then detail. A cell with no status word is done with the whole cell as detail.
function parseStatusCell(cell) {
  const text = cell.trim();
  const match = STATUS_CELL.exec(text);
  if (match) return { status: match[1].toLowerCase(), detail: text.slice(match[0].length).replace(/^\s*[—-]\s*/, "").trim(), defaulted: false };
  return { status: "done", detail: text, defaulted: true };
}

// Cells split on pipes that are not escaped; \\ and \| decode to \ and |.
function splitRow(line) {
  const cells = [];
  let current = "";
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && i + 1 < body.length && (body[i + 1] === "\\" || body[i + 1] === "|")) {
      current += body[++i];
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

// The table rows: those between the markers when the file has them, else the one table in the file.
function tableRows(markdown) {
  const marks = markersOf(markdown);
  if (marks) return markdown.slice(marks.start + TABLE_START.length, marks.end).split("\n").filter(isTableLine);
  if (markdown.includes(TABLE_START) || markdown.includes(TABLE_END)) throw new Error(`unbalanced ${TABLE_START} / ${TABLE_END} markers`);
  const lines = markdown.split("\n");
  const tables = lines.filter((line, i) => isTableLine(line) && !(i > 0 && isTableLine(lines[i - 1]))).length;
  if (tables > 1) throw new Error(`the file has ${tables} tables: wrap the one to import in ${TABLE_START} and ${TABLE_END}`);
  return lines.filter(isTableLine);
}

function isTableLine(line) {
  return line.trimStart().startsWith("|");
}

/** Positions of the one start and end marker when they appear once each, in order; null otherwise. */
function markersOf(text) {
  const start = text.indexOf(TABLE_START);
  const end = text.indexOf(TABLE_END);
  const once = text.indexOf(TABLE_START, start + 1) < 0 && text.indexOf(TABLE_END, end + 1) < 0;
  return start >= 0 && end > start && once ? { start, end } : null;
}

/**
 * Converts the Request | Priority | Status table of feature-requests.md into a task document, sorted by priority.
 * A two-cell row (the old table) is still read: title and status, with the default priority.
 */
/** The task document of a table, and the titles of the rows whose status cell had no status word (imported as done). */
export function importReport(markdown, now = Date.now()) {
  const doc = { v: TASKS_VERSION, tasks: [] };
  const defaulted = [];
  const rows = tableRows(markdown);
  const priorityColumn = rows.length > 0 && splitRow(rows[0])[1] === "Priority";
  for (const line of rows) {
    const cells = splitRow(line);
    const [title, ...rest] = cells;
    const [priorityCell, statusCell, ...extra] = priorityColumn ? rest : [undefined, ...rest];
    if (extra.length || statusCell === undefined) throw new Error(`expected ${priorityColumn ? "three" : "two"} cells: ${line}`);
    if (title === "Request" || /^:?-+:?$/.test(title)) continue;
    const parsed = parseStatusCell(statusCell);
    const priority = priorityCell !== undefined && TASK_PRIORITIES.includes(priorityCell) ? priorityCell : undefined;
    addTask(doc, { title, status: parsed.status, priority, detail: parsed.detail || undefined }, now);
    if (parsed.defaulted) defaulted.push(title);
  }
  return { doc: validateTasks({ ...doc, tasks: sortTasks(doc.tasks) }), defaulted };
}

export function importFeatureRequests(markdown, now = Date.now()) {
  return importReport(markdown, now).doc;
}

// Escapes the backslash first, so a text ending in \ keeps its meaning in the table.
const cell = (text) => String(text).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");

function statusCell(task) {
  const detail = task.detail ?? "";
  if (!detail) return task.status;
  return `${task.status}${/^[;:,]/.test(detail) ? "" : " "}${detail}`;
}

function priorityCell(task) {
  return priorityOf(task);
}

/**
 * The feature-requests.md text, sorted by priority. Only the table between the markers is replaced when `existing`
 * has them, so prose outside the markers survives a render; otherwise a full document is written.
 */
export function renderFeatureRequests(doc, existing = "") {
  const rows = sortTasks(doc.tasks).map((t) => `| ${cell(t.title)} | ${priorityCell(t)} | ${cell(statusCell(t))} |\n`).join("");
  const table = `${TABLE_START}\n${TABLE_HEAD}${rows}${TABLE_END}`;
  if (!existing.trim()) return `${DOC_PROSE}${table}\n`;
  // A file with content but no valid marker pair would lose its prose, so the render refuses it.
  const marks = markersOf(existing);
  if (!marks) throw new Error(`the file needs one ${TABLE_START} ... ${TABLE_END} pair around its table; add it or delete the file`);
  return `${existing.slice(0, marks.start)}${table}${existing.slice(marks.end + TABLE_END.length)}`;
}

/** The building tasks the session cfg owns, as tasks; [] without a session or a project. */
export function ownedBuilding(cfg, env = process.env) {
  const address = cfg.session && cfg.peer ? `${cfg.peer}#${cfg.session}` : "";
  if (!address || !cfg.project) return [];
  return openTasks(cfg.project, env).list().filter((t) => t.owner === address && t.status === "building");
}

/** Appends the text to every building task the session owns; returns how many. */
export async function recordOwnerProgress(cfg, text, env = process.env, now = Date.now()) {
  const owned = ownedBuilding(cfg, env);
  if (!owned.length) return 0;
  const backend = openTasks(cfg.project, env);
  const by = `${cfg.peer}#${cfg.session}`;
  for (const task of owned) await backend.addProgress(task.id, { by, text }, now);
  return owned.length;
}
