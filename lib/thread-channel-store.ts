/**
 * Thread channels on the Postgres bus store (docs/threads.md "Thread channels"): the thread_listeners table, the
 * store over it, and the bus routes /threads/<id>/channel, /listening, /messages and /threads/listeners.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

// oxlint-disable-next-line typescript/no-explicit-any -- database rows and request bodies are untyped JSON
type Json = any;

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Json[] }>;
}

export type ChannelSession = { session: string; member: boolean; listening: boolean | null };
export type Channel = { thread: { id: string; project: string; title: string; leadSession: string | null }; sessions: ChannelSession[] };
export type ChannelEvent = { id: string; time: number; topic: string; message: string; attachment?: unknown };

export const MESSAGES_DEFAULT = 30;
export const MESSAGES_MAX = 100;
const THREAD_ID = /^th_[a-f0-9]{16}$/;
const SESSION = /^[a-z0-9-]+#[a-f0-9]{16}$/;
const EVENT_ID = /^\d{1,15}$/;
const CHANNEL_PATH = /^\/threads\/(th_[a-f0-9]{16})\/(channel|listening|messages)$/;
const BODY_MAX_BYTES = 64 * 1024;

function bad(message: string, status = 400) {
  return Object.assign(new Error(message), { status });
}

/** The since of a thread_messages read: a message id, or an ISO time as unix seconds; null when absent. */
export function parseChannelSince(since: unknown): { kind: "id" | "time"; value: number } | null {
  if (since === undefined || since === null || since === "") return null;
  if (typeof since !== "string") throw bad("since must be an ISO time or a message id");
  if (EVENT_ID.test(since)) return { kind: "id", value: Number(since) };
  const ms = /^\d{4}-\d{2}-\d{2}/.test(since) ? Date.parse(since) : Number.NaN;
  if (!Number.isFinite(ms)) throw bad("since must be an ISO time or a message id");
  return { kind: "time", value: Math.floor(ms / 1000) };
}

/** A thread_messages limit: an integer from 1 to MESSAGES_MAX, MESSAGES_DEFAULT when absent. */
export function channelLimit(limit: unknown): number {
  if (limit === undefined || limit === null || limit === "") return MESSAGES_DEFAULT;
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1 || n > MESSAGES_MAX) throw bad(`limit must be 1-${MESSAGES_MAX}`);
  return n;
}

/** Creates thread_listeners inside the caller's open migration transaction, after the threads table. */
export async function migrateThreadChannels(client: Queryable, schema: string): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.thread_listeners (
    thread_id TEXT NOT NULL REFERENCES ${schema}.threads(id) ON DELETE CASCADE,
    session TEXT NOT NULL,
    listening BOOLEAN NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (thread_id, session)
  )`);
}

/** The channel store over one pool; `schema` is already validated by the caller. */
export function createThreadChannelStore({ pool, schema, now = Date.now }: { pool: Queryable; schema: string; now?: () => number }) {
  async function thread(id: unknown): Promise<Json> {
    if (typeof id !== "string" || !THREAD_ID.test(id)) throw bad("Invalid thread");
    const { rows } = await pool.query(`SELECT id, project, title, lead_session FROM ${schema}.threads WHERE id = $1`, [id]);
    if (!rows.length) throw bad("Unknown thread", 404);
    return rows[0];
  }

  /** The thread with its members and every stored setting, members first in join order. */
  async function channel(id: string): Promise<Channel> {
    const row = await thread(id);
    const members = await pool.query(`SELECT session FROM ${schema}.thread_sessions WHERE thread_id = $1 ORDER BY joined_at, session`, [id]);
    const settings = await pool.query(`SELECT session, listening FROM ${schema}.thread_listeners WHERE thread_id = $1 ORDER BY session`, [id]);
    const setting = new Map<string, boolean>(settings.rows.map((r) => [r.session, r.listening]));
    const sessions: ChannelSession[] = members.rows.map((r) => ({ session: r.session, member: true, listening: setting.get(r.session) ?? null }));
    const listed = new Set(sessions.map((s) => s.session));
    for (const r of settings.rows) if (!listed.has(r.session)) sessions.push({ session: r.session, member: false, listening: r.listening });
    return { thread: { id: row.id, project: row.project, title: row.title, leadSession: row.lead_session }, sessions };
  }

  /** Stores a session's setting for the thread; on null deletes it, so the role default applies again. */
  async function setListening(id: string, { session, on }: { session?: Json; on?: Json } = {}): Promise<{ thread: string; session: string; listening: boolean | null }> {
    if (typeof session !== "string" || !SESSION.test(session)) throw bad("Invalid session");
    if (on !== null && typeof on !== "boolean") throw bad("on must be true, false or null");
    await thread(id);
    if (on === null) await pool.query(`DELETE FROM ${schema}.thread_listeners WHERE thread_id = $1 AND session = $2`, [id, session]);
    else {
      await pool.query(
        `INSERT INTO ${schema}.thread_listeners (thread_id, session, listening, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (thread_id, session) DO UPDATE SET listening = EXCLUDED.listening, updated_at = EXCLUDED.updated_at`,
        [id, session, on, now()],
      );
    }
    return { thread: id, session, listening: on };
  }

  /** Posts of the thread, oldest first: after since (first `limit`), else the newest `limit`; more says whether posts remain. */
  async function messages(id: string, { since, limit }: { since?: Json; limit?: Json } = {}): Promise<{ events: ChannelEvent[]; more: boolean }> {
    await thread(id);
    const n = channelLimit(limit);
    const s = parseChannelSince(since);
    const columns = "id, time, topic, message, attachment";
    const { rows } = s === null
      ? await pool.query(`SELECT ${columns} FROM ${schema}.events WHERE thread_id = $1 ORDER BY id DESC LIMIT $2`, [id, n + 1])
      : await pool.query(`SELECT ${columns} FROM ${schema}.events WHERE thread_id = $1 AND ${s.kind === "id" ? "id > $2" : "time >= $2"} ORDER BY id LIMIT $3`, [id, s.value, n + 1]);
    const more = rows.length > n;
    const page = rows.slice(0, n);
    if (s === null) page.reverse();
    return {
      events: page.map((r) => ({ id: String(r.id), time: Number(r.time), topic: r.topic, message: r.message, ...(r.attachment ? { attachment: JSON.parse(r.attachment) } : {}) })),
      more,
    };
  }

  /** Every stored setting of the project's threads, for the UI snapshot. */
  async function listeners(project: unknown): Promise<{ thread: string; session: string; listening: boolean }[]> {
    if (typeof project !== "string" || !project) throw bad("project required");
    const { rows } = await pool.query(
      `SELECT l.thread_id, l.session, l.listening FROM ${schema}.thread_listeners l JOIN ${schema}.threads t ON t.id = l.thread_id WHERE t.project = $1 ORDER BY l.thread_id, l.session`,
      [project],
    );
    return rows.map((r) => ({ thread: r.thread_id, session: r.session, listening: r.listening }));
  }

  return { channel, setListening, messages, listeners };
}

export type ThreadChannelStore = ReturnType<typeof createThreadChannelStore>;

async function readJson(req: AsyncIterable<Buffer>): Promise<Json> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > BODY_MAX_BYTES) throw bad("body too large", 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* falls through */ }
  throw bad("bad json");
}

/** Answers one channel request; false when the path is not a channel route, so the /threads routes take it. */
export async function threadChannelRoute(store: { threadChannels?: ThreadChannelStore | null }, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const match = CHANNEL_PATH.exec(url.pathname);
  if (!match && url.pathname !== "/threads/listeners") return false;
  const reply = (status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
    return true;
  };
  const channels = store.threadChannels;
  if (!channels) return reply(404, { error: "threads need the postgres bus store" });
  try {
    const method = req.method || "GET";
    if (!match) return method === "GET" ? reply(200, { listeners: await channels.listeners(url.searchParams.get("project")) }) : reply(405, { error: "method not allowed" });
    const [, id, part] = match;
    if (part === "channel" && method === "GET") return reply(200, await channels.channel(id));
    if (part === "listening" && method === "PUT") return reply(200, await channels.setListening(id, await readJson(req)));
    if (part === "messages" && method === "GET") {
      return reply(200, await channels.messages(id, { since: url.searchParams.get("since") ?? undefined, limit: url.searchParams.get("limit") ?? undefined }));
    }
    return reply(405, { error: "method not allowed" });
  } catch (error) {
    const status = (error as { status?: number }).status || 500;
    return reply(status, { error: status === 500 ? "thread store failed" : (error as Error).message });
  }
}

/** The bus client for the channel routes ({url, token, timeoutMs}); errors carry the HTTP status. */
export function channelClient(cfg: { url: string; token?: string; timeoutMs?: number }) {
  const call = async (method: string, route: string, body?: unknown): Promise<Json> => {
    const res = await fetch(`${cfg.url}${route}`, {
      method,
      headers: { ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(cfg.timeoutMs || 5000),
    });
    const value: Json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(value.error || `threads: HTTP ${res.status}`), { status: res.status });
    return value;
  };
  const at = (id: string) => `/threads/${encodeURIComponent(id)}`;
  return {
    channel: (id: string): Promise<Channel> => call("GET", `${at(id)}/channel`),
    setListening: (id: string, session: string, on: boolean | null) => call("PUT", `${at(id)}/listening`, { session, on }),
    messages: (id: string, { since, limit }: { since?: string; limit?: number } = {}): Promise<{ events: ChannelEvent[]; more: boolean }> => {
      const query = new URLSearchParams({ ...(since ? { since } : {}), ...(limit !== undefined ? { limit: String(limit) } : {}) });
      return call("GET", `${at(id)}/messages${query.size ? `?${query}` : ""}`);
    },
    listeners: async (project: string) => (await call("GET", `/threads/listeners?project=${encodeURIComponent(project)}`)).listeners,
  };
}

export type ChannelClient = ReturnType<typeof channelClient>;
