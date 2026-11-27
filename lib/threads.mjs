/**
 * Threads on the Postgres bus store (docs/threads.md): the schema, the store the /threads routes call, and the
 * sync that gives every unassigned session a thread.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { worktreeRoot } from "./sessions/registry.ts";

export const THREAD_STATUSES = ["active", "snoozed", "settled", "archived"];
export const PR_STATES = ["draft", "open", "merged", "closed"];
export const THREAD_ID = /^th_[a-f0-9]{16}$/;
const SYNC_LOCK = 7306459; // pg_advisory_xact_lock key: one sync assigns at a time
const SESSION = /^[a-z0-9-]+#[a-f0-9]{16}$/;
const BRANCH = /^\S{1,200}$/;
const TEXT_MAX = 200;
const URL_MAX = 500;
const SYNC_MAX = 2000;

function bad(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

const clean = (value, max = TEXT_MAX) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

function text(value, name, max = TEXT_MAX) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw bad(`${name} must be a string`);
  return clean(value, max);
}

function folder(value, name) {
  const v = text(value, name, 1000);
  if (v && !path.isAbsolute(v)) throw bad(`${name} must be an absolute path`);
  return v;
}

function optional(value, pattern, name) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !pattern.test(value)) throw bad(`Invalid ${name}`);
  return value;
}

const rowThread = (row) => ({
  id: row.id,
  project: row.project,
  title: row.title,
  worktree: row.worktree,
  branch: row.branch,
  baseRef: row.base_ref,
  parentThreadId: row.parent_thread_id,
  leadSession: row.lead_session,
  patternRun: row.pattern_run,
  status: row.status,
  pinned: row.pinned,
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
});

const rowPr = (row) => ({
  id: Number(row.id),
  position: row.position,
  number: row.number === null ? null : Number(row.number),
  url: row.url,
  head: row.head,
  base: row.base,
  state: row.state,
});

/** Creates the thread tables and the events.thread_id column inside the caller's open migration transaction. */
export async function migrateThreads(client, schema) {
  const statuses = THREAD_STATUSES.map((s) => `'${s}'`).join(",");
  const states = PR_STATES.map((s) => `'${s}'`).join(",");
  await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.threads (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    worktree TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL DEFAULT '',
    base_ref TEXT NOT NULL DEFAULT '',
    parent_thread_id TEXT REFERENCES ${schema}.threads(id) ON DELETE SET NULL,
    lead_session TEXT,
    pattern_run TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (${statuses})),
    pinned BOOLEAN NOT NULL DEFAULT false,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.thread_sessions (
    project TEXT NOT NULL,
    session TEXT NOT NULL,
    thread_id TEXT NOT NULL REFERENCES ${schema}.threads(id) ON DELETE CASCADE,
    joined_at BIGINT NOT NULL,
    PRIMARY KEY (project, session)
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.thread_prs (
    id BIGSERIAL PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES ${schema}.threads(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    number BIGINT,
    url TEXT,
    head TEXT NOT NULL,
    base TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN (${states})),
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    CHECK (number IS NOT NULL OR url IS NOT NULL)
  )`);
  await client.query(`CREATE INDEX IF NOT EXISTS threads_project_updated ON ${schema}.threads(project, updated_at)`);
  await client.query(`CREATE INDEX IF NOT EXISTS threads_project_worktree ON ${schema}.threads(project, worktree)`);
  await client.query(`CREATE INDEX IF NOT EXISTS threads_project_run ON ${schema}.threads(project, pattern_run)`);
  await client.query(`CREATE INDEX IF NOT EXISTS thread_sessions_thread ON ${schema}.thread_sessions(thread_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS thread_prs_thread ON ${schema}.thread_prs(thread_id, position)`);
  await client.query(`ALTER TABLE ${schema}.events ADD COLUMN IF NOT EXISTS thread_id TEXT`);
}

/** The thread store over one pool; `schema` is already validated by the caller. */
export function createThreadStore({ pool, schema, now = Date.now }) {
  let last = 0;
  // Strictly increasing stamps keep join order when several sessions join within one millisecond.
  const stamp = () => (last = Math.max(now(), last + 1));

  async function inTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** Threads with their sessions and PRs, two queries for any number of threads. */
  async function withParts(rows, db = pool) {
    const threads = rows.map(rowThread);
    if (!threads.length) return threads;
    const ids = threads.map((t) => t.id);
    const sessions = await db.query(`SELECT thread_id, session FROM ${schema}.thread_sessions WHERE thread_id = ANY($1) ORDER BY joined_at, session`, [ids]);
    const prs = await db.query(`SELECT * FROM ${schema}.thread_prs WHERE thread_id = ANY($1) ORDER BY position, id`, [ids]);
    const byId = new Map(threads.map((t) => [t.id, Object.assign(t, { sessions: [], prs: [] })]));
    for (const row of sessions.rows) byId.get(row.thread_id).sessions.push(row.session);
    for (const row of prs.rows) byId.get(row.thread_id).prs.push(rowPr(row));
    return threads;
  }

  async function get(id, db = pool) {
    if (typeof id !== "string" || !THREAD_ID.test(id)) throw bad("Invalid thread");
    const { rows } = await db.query(`SELECT * FROM ${schema}.threads WHERE id = $1`, [id]);
    if (!rows.length) throw bad("Unknown thread", 404);
    return (await withParts(rows, db))[0];
  }

  const touch = (db, id) => db.query(`UPDATE ${schema}.threads SET updated_at = $2 WHERE id = $1`, [id, stamp()]);

  async function list({ project, archived = false } = {}) {
    if (typeof project !== "string" || !project) throw bad("project required");
    const { rows } = await pool.query(
      `SELECT * FROM ${schema}.threads WHERE project = $1 AND ($2 OR status <> 'archived') ORDER BY pinned DESC, updated_at DESC, id`,
      [project, archived === true],
    );
    return withParts(rows);
  }

  async function create(fields = {}, client = pool) {
    const project = text(fields.project, "project");
    if (!project) throw bad("project required");
    const branch = text(fields.branch, "branch");
    const baseRef = text(fields.baseRef, "baseRef");
    if (branch && !BRANCH.test(branch)) throw bad("Invalid branch");
    if (baseRef && !BRANCH.test(baseRef)) throw bad("Invalid baseRef");
    const at = stamp();
    const row = [
      `th_${randomBytes(8).toString("hex")}`, project, text(fields.title, "title"), folder(fields.worktree, "worktree"), branch, baseRef,
      optional(fields.parentThreadId, THREAD_ID, "parentThreadId"), optional(fields.leadSession, SESSION, "leadSession"),
      text(fields.patternRun, "patternRun") || null, at,
    ];
    await client.query(
      `INSERT INTO ${schema}.threads (id, project, title, worktree, branch, base_ref, parent_thread_id, lead_session, pattern_run, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      row,
    );
    return get(row[0], client);
  }

  async function update(id, { title, status, pinned, leadSession } = {}) {
    await get(id);
    const sets = [];
    const values = [id];
    const set = (column, value) => sets.push(`${column} = $${values.push(value)}`);
    if (title !== undefined) set("title", text(title, "title"));
    if (status !== undefined) {
      if (!THREAD_STATUSES.includes(status)) throw bad("Invalid status");
      set("status", status);
    }
    if (pinned !== undefined) {
      if (typeof pinned !== "boolean") throw bad("pinned must be true or false");
      set("pinned", pinned);
    }
    if (leadSession !== undefined) set("lead_session", optional(leadSession, SESSION, "leadSession"));
    set("updated_at", stamp());
    await pool.query(`UPDATE ${schema}.threads SET ${sets.join(", ")} WHERE id = $1`, values);
    return get(id);
  }

  async function attachPr(id, { number, url, head, base, state = "open", position } = {}) {
    if (number !== undefined && number !== null && !(Number.isSafeInteger(number) && number > 0)) throw bad("Invalid PR number");
    if (url !== undefined && url !== null && !(typeof url === "string" && url.startsWith("https://") && url.length <= URL_MAX && !/\s/.test(url))) throw bad("Invalid PR url");
    if ((number === undefined || number === null) && (url === undefined || url === null)) throw bad("A PR needs a number or a url");
    if (typeof head !== "string" || !BRANCH.test(head) || typeof base !== "string" || !BRANCH.test(base)) throw bad("Invalid head or base");
    if (!PR_STATES.includes(state)) throw bad("Invalid PR state");
    if (position !== undefined && position !== null && !(Number.isSafeInteger(position) && position >= 0)) throw bad("Invalid position");
    await get(id);
    await inTransaction(async (client) => {
      await client.query(`SELECT id FROM ${schema}.threads WHERE id = $1 FOR UPDATE`, [id]);
      const { rows } = await client.query(`SELECT COALESCE(MAX(position) + 1, 0) AS next FROM ${schema}.thread_prs WHERE thread_id = $1`, [id]);
      const next = Number(rows[0].next);
      const at = position === undefined || position === null ? next : Math.min(position, next);
      await client.query(`UPDATE ${schema}.thread_prs SET position = position + 1 WHERE thread_id = $1 AND position >= $2`, [id, at]);
      const time = stamp();
      await client.query(
        `INSERT INTO ${schema}.thread_prs (thread_id, position, number, url, head, base, state, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [id, at, number ?? null, url ?? null, head, base, state, time],
      );
      await touch(client, id);
    });
    return get(id);
  }

  async function detachPr(id, prId) {
    if (!Number.isSafeInteger(prId) || prId <= 0) throw bad("Invalid PR");
    await get(id);
    await inTransaction(async (client) => {
      await client.query(`SELECT id FROM ${schema}.threads WHERE id = $1 FOR UPDATE`, [id]);
      const { rows } = await client.query(`DELETE FROM ${schema}.thread_prs WHERE id = $1 AND thread_id = $2 RETURNING position`, [prId, id]);
      if (!rows.length) throw bad("Unknown PR", 404);
      await client.query(`UPDATE ${schema}.thread_prs SET position = position - 1 WHERE thread_id = $1 AND position > $2`, [id, rows[0].position]);
      await touch(client, id);
    });
    return get(id);
  }

  const join = (db, project, session, threadId) => db.query(
    `INSERT INTO ${schema}.thread_sessions (project, session, thread_id, joined_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (project, session) DO UPDATE SET thread_id = EXCLUDED.thread_id, joined_at = EXCLUDED.joined_at`,
    [project, session, threadId, stamp()],
  );

  async function moveSession(id, { session } = {}) {
    if (typeof session !== "string" || !SESSION.test(session)) throw bad("Invalid session");
    const thread = await get(id);
    await join(pool, thread.project, session, id);
    await touch(pool, id);
    return get(id);
  }

  /** Gives each unassigned session a thread by the docs/threads.md "Assignment" rules; fills an empty worktree on the way. */
  async function sync({ project, root = "", sessions } = {}) {
    if (typeof project !== "string" || !project) throw bad("project required");
    if (!Array.isArray(sessions) || sessions.length > SYNC_MAX) throw bad("sessions must be an array");
    const base = folder(root, "root");
    const input = sessions.filter((s) => s && typeof s.address === "string" && SESSION.test(s.address) && typeof s.cwd === "string" && path.isAbsolute(s.cwd));
    return inTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [SYNC_LOCK]);
      const threads = new Map((await client.query(`SELECT * FROM ${schema}.threads WHERE project = $1 ORDER BY created_at, id`, [project])).rows.map((row) => [row.id, rowThread(row)]));
      const member = new Map();
      for (const row of (await client.query(`SELECT session, thread_id FROM ${schema}.thread_sessions WHERE project = $1`, [project])).rows) {
        member.set(row.session, threads.get(row.thread_id));
      }
      const assigned = [];
      let created = 0;
      const tree = (s) => (typeof s.worktree === "string" && path.isAbsolute(s.worktree) && s.worktree) || (base && (s.cwd === base || s.cwd.startsWith(base + path.sep)) ? base : s.cwd);
      const branchOf = (s) => (typeof s.branch === "string" && BRANCH.test(s.branch) ? s.branch : "");
      const nameOf = (s) => (typeof s.name === "string" ? clean(s.name) : "");
      const open = async (fields) => {
        const thread = await create({ project, ...fields }, client);
        threads.set(thread.id, thread);
        created += 1;
        return thread;
      };
      const place = async (s) => {
        const where = tree(s);
        const parent = typeof s.parent === "string" ? member.get(s.parent) : undefined;
        if (parent && (parent.worktree === where || !parent.worktree)) return parent;
        const titled = { worktree: where, branch: branchOf(s) };
        if (parent) return open({ ...titled, title: nameOf(s) || path.basename(where), parentThreadId: parent.id });
        if (typeof s.patternRun === "string" && s.patternRun) {
          const run = [...threads.values()].find((t) => t.patternRun === s.patternRun);
          return run || open({ ...titled, title: `run ${s.patternRun}`, patternRun: s.patternRun });
        }
        if (where !== base) {
          const shared = [...threads.values()].find((t) => t.worktree === where);
          return shared || open({ ...titled, title: nameOf(s) || path.basename(where) });
        }
        return open({ ...titled, title: nameOf(s) || s.address });
      };

      // Threads a UI start created before the session had a folder take the folder of their first session.
      for (const s of input) {
        const thread = member.get(s.address);
        if (!thread || thread.worktree) continue;
        thread.worktree = tree(s);
        thread.branch ||= branchOf(s);
        await client.query(`UPDATE ${schema}.threads SET worktree = $2, branch = $3, updated_at = $4 WHERE id = $1`, [thread.id, thread.worktree, thread.branch, stamp()]);
      }

      let pending = input.filter((s) => !member.has(s.address));
      let force = false;
      while (pending.length) {
        const waiting = new Set(pending.map((s) => s.address));
        const ready = force ? pending : pending.filter((s) => !(typeof s.parent === "string" && waiting.has(s.parent) && s.parent !== s.address));
        // A parent cycle makes no progress; then the remaining parents count as absent.
        if (!ready.length) { force = true; continue; }
        for (const s of ready) {
          const thread = await place(s);
          await join(client, project, s.address, thread.id);
          member.set(s.address, thread);
          assigned.push({ session: s.address, thread: thread.id });
        }
        const done = new Set(ready.map((s) => s.address));
        pending = pending.filter((s) => !done.has(s.address));
      }
      return { assigned, created };
    });
  }

  return { list, get: (id) => get(id), create: (fields) => create(fields), update, attachPr, detachPr, moveSession, sync };
}

/** The sync input for one project: registry sessions and owned records merged by address, owned fields first. */
export function threadSessionsOf({ sessions = [], owned = [], root = "" }) {
  const byAddress = new Map();
  for (const s of sessions) {
    if (!s || typeof s.id !== "string") continue;
    byAddress.set(s.id, { address: s.id, cwd: s.cwd, parent: s.parent, name: s.identityName || s.name, branch: s.branch });
  }
  for (const o of owned) {
    if (!o || typeof o.address !== "string") continue;
    const seen = byAddress.get(o.address) || { address: o.address };
    byAddress.set(o.address, { ...seen, cwd: o.cwd ?? seen.cwd, parent: o.parent ?? seen.parent, patternRun: o.patternRun ?? seen.patternRun });
  }
  return [...byAddress.values()]
    .filter((s) => typeof s.cwd === "string" && path.isAbsolute(s.cwd))
    .map((s) => ({
      address: s.address,
      cwd: s.cwd,
      worktree: worktreeRoot(s.cwd, root),
      parent: typeof s.parent === "string" ? s.parent : null,
      patternRun: typeof s.patternRun === "string" ? s.patternRun : null,
      name: typeof s.name === "string" ? s.name : "",
      branch: typeof s.branch === "string" ? s.branch : "",
    }));
}
