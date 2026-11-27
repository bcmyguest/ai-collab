/**
 * The bus's /threads routes (docs/threads.md "Bus routes") over a store's `threads` object, and the client the
 * UI server calls them with. A store without threads (the memory store) answers 404 to every route.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

const BODY_MAX_BYTES = 1024 * 1024;
const THREAD_PATH = /^\/threads\/(th_[a-f0-9]{16})(?:\/(prs|sessions)(?:\/(\d{1,12}))?)?$/;

// oxlint-disable-next-line typescript/no-explicit-any -- request bodies and thread rows are JSON the store validates
type Json = any;

/** The thread store a bus store may carry (lib/threads). */
export interface ThreadStore {
  list(query: { project: string; archived: boolean }): Promise<Json>;
  create(fields: Json): Promise<Json>;
  sync(input: Json): Promise<Json>;
  get(id: string): Promise<Json>;
  update(id: string, fields: Json): Promise<Json>;
  attachPr(id: string, pr: Json): Promise<Json>;
  detachPr(id: string, prId: number): Promise<Json>;
  moveSession(id: string, body: Json): Promise<Json>;
}

/** Bus URL, token and request timeout for threadClient. */
export type ThreadClientConfig = { url: string; token?: string; timeoutMs?: number };
type HttpError = Error & { status?: number; code?: string };

async function readJson(req: AsyncIterable<Buffer>): Promise<Json> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > BODY_MAX_BYTES) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* falls through */ }
  throw Object.assign(new Error("bad json"), { status: 400 });
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

/** Answers one /threads request; false when the path is not a thread route. */
export async function threadRoute(store: { threads?: ThreadStore | null }, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== "/threads" && !url.pathname.startsWith("/threads/")) return false;
  const threads = store.threads;
  const reply = (status: number, value: unknown): boolean => {
    send(res, status, value);
    return true;
  };
  if (!threads) return reply(404, { error: "threads need the postgres bus store" });
  try {
    const method = req.method;
    if (url.pathname === "/threads" && method === "GET") {
      return reply(200, { threads: await threads.list({ project: url.searchParams.get("project") || "", archived: url.searchParams.get("archived") === "1" }) });
    }
    if (url.pathname === "/threads" && method === "POST") return reply(201, await threads.create(await readJson(req)));
    if (url.pathname === "/threads/sync" && method === "POST") return reply(200, await threads.sync(await readJson(req)));
    const match = THREAD_PATH.exec(url.pathname);
    if (!match) return reply(404, { error: "unknown thread route" });
    const [, id, part, prId] = match;
    if (!part && method === "GET") return reply(200, await threads.get(id));
    if (!part && method === "PATCH") return reply(200, await threads.update(id, await readJson(req)));
    if (part === "prs" && !prId && method === "POST") return reply(201, await threads.attachPr(id, await readJson(req)));
    if (part === "prs" && prId && method === "DELETE") return reply(200, await threads.detachPr(id, Number(prId)));
    if (part === "sessions" && !prId && method === "POST") return reply(200, await threads.moveSession(id, await readJson(req)));
    return reply(405, { error: "method not allowed" });
  } catch (error) {
    // Postgres check and foreign-key violations are the caller's bad input.
    const status = (error as HttpError).status || (/^23/.test((error as HttpError).code || "") ? 400 : 500);
    return reply(status, { error: status === 500 ? "thread store failed" : (error as HttpError).message });
  }
}

/** The bus /threads client for one config ({url, token, timeoutMs}); a 404 from a store without threads reads as unavailable. */
export function threadClient(cfg: ThreadClientConfig) {
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
    list: async (project: string, { archived = false }: { archived?: boolean } = {}): Promise<Json> => (await call("GET", `/threads?project=${encodeURIComponent(project)}${archived ? "&archived=1" : ""}`)).threads,
    get: (id: string) => call("GET", at(id)),
    create: (fields: unknown) => call("POST", "/threads", fields),
    update: (id: string, fields: unknown) => call("PATCH", at(id), fields),
    attachPr: (id: string, pr: unknown) => call("POST", `${at(id)}/prs`, pr),
    detachPr: (id: string, prId: string | number) => call("DELETE", `${at(id)}/prs/${encodeURIComponent(prId)}`),
    moveSession: (id: string, session: unknown) => call("POST", `${at(id)}/sessions`, { session }),
    sync: (input: unknown) => call("POST", "/threads/sync", input),
  };
}
