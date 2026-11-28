/**
 * Threads on the Postgres bus store (docs/threads.md): the schema, the store the /threads routes call, and the
 * sync that gives every unassigned session a thread.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { worktreeRoot } from "./sessions/registry.ts";

// oxlint-disable-next-line typescript/no-explicit-any -- database rows and request fields are untyped JSON
type Json = any;

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Json[] }>;
}

interface DbClient extends Queryable {
  release(): void;
}

interface DbPool extends Queryable {
  connect(): Promise<DbClient>;
}

interface Thread {
  id: string;
  project: string;
  title: string;
  worktree: string;
  branch: string;
  baseRef: string;
  parentThreadId: string | null;
  leadSession: string | null;
  patternRun: string | null;
  status: string;
  pinned: boolean;
  titleSource: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Pr {
  id: number;
  position: number;
  number: number | null;
  url: string | null;
  head: string;
  base: string;
  state: string;
}

interface ThreadWithParts extends Thread {
  sessions: string[];
  prs: Pr[];
}

export const THREAD_STATUSES = ["active", "snoozed", "settled", "archived"];
export const PR_STATES = ["draft", "open", "merged", "closed"];
export const THREAD_ID = /^th_[a-f0-9]{16}$/;
// auto: the sync names the thread from its lead session; operator: a rename froze it; NULL: a row from before the column.
export const TITLE_SOURCES = ["auto", "operator"];
const SYNC_LOCK = 7306459; // pg_advisory_xact_lock key: one sync assigns at a time
const SESSION = /^[a-z0-9-]+#[a-f0-9]{16}$/;
const BRANCH = /^\S{1,200}$/;
const TEXT_MAX = 200;
const URL_MAX = 500;
const SYNC_MAX = 2000;
const PROMPT_TITLE_MAX = 60;
export const UNTITLED = "Untitled";
// A worktree or subagent label repeats the address and names nothing.
const MACHINE_NAME = /^agent-[0-9a-f]{8,}$/i;

function bad(message: string, status = 400) {
  return Object.assign(new Error(message), { status });
}

const clean = (value: unknown, max = TEXT_MAX) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

function text(value: unknown, name: string, max = TEXT_MAX): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw bad(`${name} must be a string`);
  return clean(value, max);
}

function folder(value: unknown, name: string): string {
  const v = text(value, name, 1000);
  if (v && !path.isAbsolute(v)) throw bad(`${name} must be an absolute path`);
  return v;
}

function optional(value: unknown, pattern: RegExp, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !pattern.test(value)) throw bad(`Invalid ${name}`);
  return value;
}

const rowThread = (row: Json): Thread => ({
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
  titleSource: row.title_source ?? null,
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
});

const rowPr = (row: Json): Pr => ({
  id: Number(row.id),
  position: row.position,
  number: row.number === null ? null : Number(row.number),
  url: row.url,
  head: row.head,
  base: row.base,
  state: row.state,
});

/** Creates the thread tables and the events.thread_id column inside the caller's open migration transaction. */
export async function migrateThreads(client: Queryable, schema: string): Promise<void> {
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
  const sources = TITLE_SOURCES.map((s) => `'${s}'`).join(",");
  await client.query(`ALTER TABLE ${schema}.threads ADD COLUMN IF NOT EXISTS title_source TEXT CHECK (title_source IN (${sources}))`);
}

type TitleInput = { activity?: unknown; prompt?: unknown; name?: unknown };

/** The title a lead session gives its thread: its set_identity activity line, else its first prompt's first line, clipped to 60. */
export function sessionTitle({ activity, prompt }: TitleInput): string {
  const line = (value: unknown) => String(value ?? "").split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).find(Boolean) || "";
  return clean(line(activity)) || clean(line(prompt), PROMPT_TITLE_MAX);
}

/** A title when the session has given none: its name, else the worktree folder; never the session address. */
function fallbackTitle(s: TitleInput, worktree: string, base: string): string {
  const name = typeof s.name === "string" ? clean(s.name) : "";
  if (name && !name.includes("#") && !MACHINE_NAME.test(name)) return name;
  return worktree && worktree !== base ? path.basename(worktree) : UNTITLED;
}

// The names the sync gave before sessions named their threads: an address, or the worktree folder.
const placeholder = (title: string, worktree: string) => title.includes("#") || Boolean(worktree && title === path.basename(worktree));
// A pattern run's thread before its session names it.
const RUN_TITLE = /^run \S+$/;
const flat = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();

/**
 * The thread's next title from its lead session, or null to keep it: an operator rename keeps it; a row from before
 * title_source changes only while its title is a placeholder; an auto title follows the activity line, and takes a prompt
 * title only over a fallback or a title cut from that same prompt, so a later prompt never replaces the first.
 */
export function nextTitle(thread: { title: string; titleSource?: string | null; worktree?: string }, lead: TitleInput, base = ""): string | null {
  if (thread.titleSource === "operator") return null;
  const worktree = thread.worktree || "";
  const own = sessionTitle(lead);
  const stale = placeholder(thread.title, worktree);
  if (thread.titleSource !== "auto" && !stale) return null;
  const fallback = fallbackTitle(lead, worktree, base);
  const filler = stale || thread.title === fallback || thread.title === UNTITLED || RUN_TITLE.test(thread.title);
  const activity = sessionTitle({ activity: lead.activity });
  const fromPrompt = Boolean(thread.title) && flat(lead.prompt).startsWith(flat(thread.title));
  const next = activity || (own && (filler || fromPrompt) ? own : stale ? fallback : thread.title);
  return next !== thread.title ? next : null;
}

/** The session a thread is named after: its lead, else its first member. */
export const leadOf = (thread: { leadSession?: string | null; sessions?: string[] }): string => thread.leadSession || thread.sessions?.[0] || "";

/** Where a thread runs: "main" for the project root, else its worktree folder; "" without a worktree. */
export function threadPlace(worktree: unknown, root = ""): string {
  if (typeof worktree !== "string" || !worktree) return "";
  return root && worktree === root ? "main" : path.basename(worktree);
}

/** The thread store over one pool; `schema` is already validated by the caller. */
export function createThreadStore({ pool, schema, now = Date.now }: { pool: DbPool; schema: string; now?: () => number }) {
  let last = 0;
  // Strictly increasing stamps keep join order when several sessions join within one millisecond.
  const stamp = () => (last = Math.max(now(), last + 1));

  async function inTransaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
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
  async function withParts(rows: Json[], db: Queryable = pool): Promise<Thread[]> {
    const threads = rows.map(rowThread);
    if (!threads.length) return threads;
    const ids = threads.map((t) => t.id);
    const sessions = await db.query(`SELECT thread_id, session FROM ${schema}.thread_sessions WHERE thread_id = ANY($1) ORDER BY joined_at, session`, [ids]);
    const prs = await db.query(`SELECT * FROM ${schema}.thread_prs WHERE thread_id = ANY($1) ORDER BY position, id`, [ids]);
    const byId = new Map(threads.map((t): [string, ThreadWithParts] => [t.id, Object.assign(t, { sessions: [], prs: [] })]));
    for (const row of sessions.rows) (byId.get(row.thread_id) as ThreadWithParts).sessions.push(row.session);
    for (const row of prs.rows) (byId.get(row.thread_id) as ThreadWithParts).prs.push(rowPr(row));
    return threads;
  }

  async function get(id: string, db: Queryable = pool): Promise<Thread> {
    if (typeof id !== "string" || !THREAD_ID.test(id)) throw bad("Invalid thread");
    const { rows } = await db.query(`SELECT * FROM ${schema}.threads WHERE id = $1`, [id]);
    if (!rows.length) throw bad("Unknown thread", 404);
    return (await withParts(rows, db))[0];
  }

  const touch = (db: Queryable, id: string) => db.query(`UPDATE ${schema}.threads SET updated_at = $2 WHERE id = $1`, [id, stamp()]);

  async function list({ project, archived = false }: { project?: Json; archived?: Json } = {}): Promise<Thread[]> {
    if (typeof project !== "string" || !project) throw bad("project required");
    const { rows } = await pool.query(
      `SELECT * FROM ${schema}.threads WHERE project = $1 AND ($2 OR status <> 'archived') ORDER BY pinned DESC, updated_at DESC, id`,
      [project, archived === true],
    );
    return withParts(rows);
  }

  async function create(fields: Json = {}, client: Queryable = pool): Promise<Thread> {
    const project = text(fields.project, "project");
    if (!project) throw bad("project required");
    const branch = text(fields.branch, "branch");
    const baseRef = text(fields.baseRef, "baseRef");
    if (branch && !BRANCH.test(branch)) throw bad("Invalid branch");
    if (baseRef && !BRANCH.test(baseRef)) throw bad("Invalid baseRef");
    const titleSource = fields.titleSource === undefined ? "auto" : fields.titleSource;
    if (!TITLE_SOURCES.includes(titleSource)) throw bad("Invalid titleSource");
    const at = stamp();
    const row: Json[] = [
      `th_${randomBytes(8).toString("hex")}`, project, text(fields.title, "title"), folder(fields.worktree, "worktree"), branch, baseRef,
      optional(fields.parentThreadId, THREAD_ID, "parentThreadId"), optional(fields.leadSession, SESSION, "leadSession"),
      text(fields.patternRun, "patternRun") || null, at, titleSource,
    ];
    await client.query(
      `INSERT INTO ${schema}.threads (id, project, title, worktree, branch, base_ref, parent_thread_id, lead_session, pattern_run, created_at, updated_at, title_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11)`,
      row,
    );
    return get(row[0], client);
  }

  async function update(id: string, { title, status, pinned, leadSession }: { title?: Json; status?: Json; pinned?: Json; leadSession?: Json } = {}): Promise<Thread> {
    await get(id);
    const sets: string[] = [];
    const values: unknown[] = [id];
    const set = (column: string, value: unknown) => sets.push(`${column} = $${values.push(value)}`);
    if (title !== undefined) {
      set("title", text(title, "title"));
      set("title_source", "operator");
    }
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

  async function attachPr(id: string, { number, url, head, base, state = "open", position }: { number?: Json; url?: Json; head?: Json; base?: Json; state?: string; position?: Json } = {}): Promise<Thread> {
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

  async function detachPr(id: string, prId: number): Promise<Thread> {
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

  const join = (db: Queryable, project: string, session: string, threadId: string) => db.query(
    `INSERT INTO ${schema}.thread_sessions (project, session, thread_id, joined_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (project, session) DO UPDATE SET thread_id = EXCLUDED.thread_id, joined_at = EXCLUDED.joined_at`,
    [project, session, threadId, stamp()],
  );

  async function moveSession(id: string, { session }: { session?: Json } = {}): Promise<Thread> {
    if (typeof session !== "string" || !SESSION.test(session)) throw bad("Invalid session");
    const thread = await get(id);
    await join(pool, thread.project, session, id);
    await touch(pool, id);
    return get(id);
  }

  /** Gives each unassigned session a thread by the docs/threads.md "Assignment" rules; fills an empty worktree on the way. */
  async function sync({ project, root = "", sessions }: { project?: Json; root?: string; sessions?: Json[] } = {}) {
    if (typeof project !== "string" || !project) throw bad("project required");
    if (!Array.isArray(sessions) || sessions.length > SYNC_MAX) throw bad("sessions must be an array");
    const base = folder(root, "root");
    const input = sessions.filter((s) => s && typeof s.address === "string" && SESSION.test(s.address) && typeof s.cwd === "string" && path.isAbsolute(s.cwd));
    return inTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [SYNC_LOCK]);
      const threads = new Map<string, Thread>((await client.query(`SELECT * FROM ${schema}.threads WHERE project = $1 ORDER BY created_at, id`, [project])).rows.map((row) => [row.id, rowThread(row)]));
      const member = new Map<string, Thread | undefined>();
      for (const row of (await client.query(`SELECT session, thread_id FROM ${schema}.thread_sessions WHERE project = $1`, [project])).rows) {
        member.set(row.session, threads.get(row.thread_id));
      }
      const assigned: Json[] = [];
      let created = 0;
      const tree = (s: Json) => (typeof s.worktree === "string" && path.isAbsolute(s.worktree) && s.worktree) || (base && (s.cwd === base || s.cwd.startsWith(base + path.sep)) ? base : s.cwd);
      const branchOf = (s: Json) => (typeof s.branch === "string" && BRANCH.test(s.branch) ? s.branch : "");
      const titleOf = (s: Json, where: string) => sessionTitle(s) || fallbackTitle(s, where, base);
      const open = async (fields: Json) => {
        const thread = await create({ project, ...fields }, client);
        threads.set(thread.id, thread);
        created += 1;
        return thread;
      };
      const place = async (s: Json) => {
        const where = tree(s);
        const parent = typeof s.parent === "string" ? member.get(s.parent) : undefined;
        if (parent && (parent.worktree === where || !parent.worktree)) return parent;
        const titled = { worktree: where, branch: branchOf(s) };
        if (parent) return open({ ...titled, title: titleOf(s, where), parentThreadId: parent.id });
        if (typeof s.patternRun === "string" && s.patternRun) {
          const run = [...threads.values()].find((t) => t.patternRun === s.patternRun);
          return run || open({ ...titled, title: sessionTitle(s) || `run ${s.patternRun}`, patternRun: s.patternRun });
        }
        if (where !== base) {
          const shared = [...threads.values()].find((t) => t.worktree === where);
          return shared || open({ ...titled, title: titleOf(s, where) });
        }
        return open({ ...titled, title: titleOf(s, where) });
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

      // Each thread takes its lead's title (docs/threads.md "Naming"); a rename stops it. updated_at stays: naming is not work.
      const byAddress = new Map<string, Json>(input.map((s) => [s.address, s]));
      const members = new Map<string, string[]>();
      for (const row of (await client.query(`SELECT thread_id, session FROM ${schema}.thread_sessions WHERE project = $1 ORDER BY joined_at, session`, [project])).rows) {
        members.set(row.thread_id, [...(members.get(row.thread_id) || []), row.session]);
      }
      let retitled = 0;
      for (const thread of threads.values()) {
        const lead = byAddress.get(leadOf({ leadSession: thread.leadSession, sessions: members.get(thread.id) }));
        const title = lead ? nextTitle(thread, lead, base) : null;
        if (title === null) continue;
        await client.query(`UPDATE ${schema}.threads SET title = $2, title_source = 'auto' WHERE id = $1`, [thread.id, title]);
        thread.title = title;
        retitled += 1;
      }
      return { assigned, created, ...(retitled ? { retitled } : {}) };
    });
  }

  return { list, get: (id: string) => get(id), create: (fields: Json) => create(fields), update, attachPr, detachPr, moveSession, sync };
}

/** The sync input for one project: registry sessions and owned records merged by address, owned fields first. */
export function threadSessionsOf({ sessions = [], owned = [], root = "", prompts }: { sessions?: Json[]; owned?: Json[]; root?: string; prompts?: Map<string, string> }) {
  const byAddress = new Map<string, Json>();
  for (const s of sessions) {
    if (!s || typeof s.id !== "string") continue;
    byAddress.set(s.id, { address: s.id, cwd: s.cwd, parent: s.parent, name: s.identityName || s.name, branch: s.branch, activity: s.activity });
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
      activity: typeof s.activity === "string" ? s.activity : "",
      prompt: prompts?.get(s.address) || "",
    }));
}
