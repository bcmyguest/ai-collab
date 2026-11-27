/**
 * The local message bus: the ntfy-subset HTTP API the plugin already speaks, served from this machine's
 * Postgres (lib/bus-postgres.mjs) instead of a container. Same topics, same JSON-line protocol, same
 * Bearer token, so every client (hooks, runner, UI server, tests) is unchanged; what changes is where events live.
 *
 * Endpoints (the subset lib/messaging.ts uses):
 *   POST /                        JSON publish {topic, message, title?}
 *   PUT  /<topic>?message=&filename=   attachment publish, file as the body
 *   GET  /file/<id>               attachment bytes
 *   GET  /<topic>/json?poll=1&since=   cached bounded read (NDJSON)
 *   GET  /<t1,t2>/json?since=          streaming subscription (NDJSON until close)
 *
 * Durability: events and attachments survive a restart, and retention is days instead of ntfy's 12 h
 * cache, so an AFK gap or a runner restart cannot drop an approval or a reply. No rate limits: the
 * bus is loopback-only (sandboxes arrive through host.openshell.internal) behind a shared token.
 */
import http from "node:http";
import { threadRoute } from "./thread-routes.mjs";

export const DEFAULT_RETENTION_MS = 7 * 24 * 3_600_000;
const MESSAGE_MAX_BYTES = 64 * 1024;
const FILE_MAX_BYTES = 16 * 1024 * 1024;
const FILE_EXT = /\.(png|jpe?g|gif|webp|txt)$/i;

const FILE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".txt": "text/plain; charset=utf-8" };

function fileType(name) {
  const ext = String(name).slice(String(name).lastIndexOf(".")).toLowerCase();
  return FILE_TYPES[ext] || "application/octet-stream";
}

// ntfy turns the two characters \n of a query-string message into a newline; clients respell them, and the
// bus turns them back. Kept so the wire stays identical for anything that already escapes this way.
const unescapeQuery = (text) => String(text ?? "").replaceAll("\\n", "\n");

/** The store kind: AI_COLLAB_BUS_STORE, else defaults.json busStore, else postgres; the SQLite store is retired. */
export function resolveBusStoreKind(env = process.env, defaults = {}) {
  const kind = env.AI_COLLAB_BUS_STORE || defaults.busStore || "postgres";
  if (kind === "sqlite") throw new Error("bus: the SQLite store (bus.db) is retired; copy it with `ai-collab bus migrate --to postgres`, then set busStore to postgres or remove it (docs/configuration.md#bus-store)");
  if (kind !== "postgres") throw new Error(`bus: unknown store ${kind}; use postgres`);
  return kind;
}

/**
 * "since" as clients send it: "all", a duration (90m, 12h, 3d), unix seconds (9+ digits), or an event id.
 * Returns {kind, value} where kind is all|time|id|none.
 */
export function parseSince(since, nowSec = Math.floor(Date.now() / 1000)) {
  const s = String(since ?? "");
  if (s === "" || s === "all") return { kind: "all" };
  const dur = /^(\d+)(s|m|h|d)$/.exec(s);
  if (dur) {
    const unit = { s: 1, m: 60, h: 3600, d: 86400 }[dur[2]];
    return { kind: "time", value: nowSec - Number(dur[1]) * unit };
  }
  if (/^\d{9,}$/.test(s)) return { kind: "time", value: Number(s) };
  if (/^\d+$/.test(s)) return { kind: "id", value: Number(s) };
  return { kind: "none" };
}

/**
 * The store interface the server calls. Every operation may return a value or a promise (the server awaits):
 *   kind                        "memory" | "postgres"
 *   publish({topic, message, title, attachment}) -> event
 *   resolve(topics, since) -> {since, reset}      the since to read from; an unknown id reads all, reset true
 *   poll(topic, since) -> events                  the cached read
 *   stream(topics, since, send) -> unsubscribe    backfill from since, then each new event for topics
 *   putFile({name, data}) -> {file, type, size}
 *   getFile(id) -> {data, type, name, size} | null
 *   prune(nowSec?) -> {events, files}
 *   threads?                    the thread store (lib/threads.mjs); Postgres only, docs/threads.md
 *   close()
 */

/** Events and attachments in memory: what the test fake runs on, and enough for a throwaway bus. */
export function openMemoryStore() {
  const events = [];
  const subscribers = new Set();
  const state = { seq: 0, files: new Map() };
  const store = {
    kind: "memory",
    files: state.files,
    publish({ topic, message, title = "", attachment = null }) {
      state.seq += 1;
      const ev = {
        id: String(state.seq),
        time: Math.floor(Date.now() / 1000),
        event: "message",
        topic,
        message,
        title,
        ...(attachment ? { attachment } : {}),
      };
      events.push(ev);
      for (const send of subscribers) send(ev);
      return ev;
    },
    resolve(topics, since) {
      const s = parseSince(since);
      if (s.kind === "all" || s.kind === "time") return { since, reset: false };
      const known = s.kind === "id" && events.some((e) => topics.includes(e.topic) && Number(e.id) === s.value);
      return known ? { since, reset: false } : { since: "all", reset: true };
    },
    poll(topic, since) {
      const all = events.filter((e) => e.topic === topic);
      const s = parseSince(since || "all");
      if (s.kind === "all") return all;
      if (s.kind === "time") return all.filter((e) => e.time >= s.value);
      if (s.kind === "id") {
        const idx = all.findIndex((e) => Number(e.id) === s.value);
        return idx >= 0 ? all.slice(idx + 1) : all; // unknown id: everything, dedup must cope
      }
      return all;
    },
    backfill(topics, since) {
      const s = parseSince(since);
      const all = events.filter((e) => topics.includes(e.topic));
      if (s.kind === "all") return all;
      if (s.kind === "time") return all.filter((e) => e.time >= s.value);
      if (s.kind === "id") return all.filter((e) => Number(e.id) > s.value);
      return [];
    },
    subscribe(send) {
      subscribers.add(send);
      return () => subscribers.delete(send);
    },
    stream(topics, since, send) {
      for (const ev of store.backfill(topics, since)) send(ev);
      return store.subscribe((ev) => { if (topics.includes(ev.topic)) send(ev); });
    },
    putFile({ name, data }) {
      const ext = (FILE_EXT.exec(name)?.[0] || ".bin").toLowerCase();
      const file = `f${state.files.size + 1}${ext}`;
      state.files.set(file, { data, type: fileType(name) });
      return { file, type: fileType(name), size: data.length };
    },
    getFile(id) {
      const hit = state.files.get(String(id));
      return hit ? { ...hit, name: String(id), size: hit.data.length } : null;
    },
    prune() { return { events: 0, files: 0 }; },
    close() { subscribers.clear(); },
  };
  return store;
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      req.destroy();
      throw Object.assign(new Error("body too large"), { status: 413 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * The bus server. `store` holds events and attachments; `token` (when set) is required as a Bearer token
 * on every request, the same trust boundary the ntfy token was. `hooks` is optional and test-only: onRequest
 * (awaited first), fault(req) and onPoll(rec) may return {status, body, headers} to refuse a request, and
 * onPublish, onPoll, onSubscribe, onFileRead observe traffic. Production passes none and keeps no log.
 */
export function createBusServer({ store, token = "", baseUrl = "", hooks = {} }) {
  const server = http.createServer(async (req, res) => {
    await hooks.onRequest?.(req);
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    const fault = hooks.fault?.(req);
    if (fault) {
      res.writeHead(fault.status, fault.headers || {});
      return res.end(fault.body);
    }
    const url = new URL(req.url, "http://bus.invalid");
    const base = () => baseUrl || `http://127.0.0.1:${server.address().port}`;

    if (req.method === "POST" && url.pathname === "/") {
      let body;
      try { body = JSON.parse((await readBody(req, MESSAGE_MAX_BYTES)).toString("utf8")); } catch {
        res.writeHead(400);
        return res.end("bad json");
      }
      if (typeof body.topic !== "string" || typeof body.message !== "string") {
        res.writeHead(400);
        return res.end("missing topic or message");
      }
      const ev = await store.publish({ topic: body.topic, message: body.message, title: body.title || "", ...(typeof body.thread_id === "string" ? { threadId: body.thread_id } : {}) });
      hooks.onPublish?.({ id: ev.id, topic: body.topic, message: body.message, title: body.title || "", auth: req.headers.authorization || "" });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(ev));
    }

    const put = /^\/([^/]+)$/.exec(url.pathname);
    if (req.method === "PUT" && put) {
      let data;
      try { data = await readBody(req, FILE_MAX_BYTES); } catch (error) {
        res.writeHead(error.status || 400);
        return res.end(error.message);
      }
      const name = url.searchParams.get("filename") || "file";
      const saved = await store.putFile({ name, data });
      const topic = decodeURIComponent(put[1]);
      const message = unescapeQuery(url.searchParams.get("message"));
      const title = url.searchParams.get("title") || "";
      const threadId = url.searchParams.get("thread_id");
      const ev = await store.publish({
        topic, message, title, ...(threadId ? { threadId } : {}),
        attachment: { name, type: saved.type, size: saved.size, url: `${base()}/file/${saved.file}` },
      });
      hooks.onPublish?.({ id: ev.id, topic, message, title, auth: req.headers.authorization || "", attachment: { name, size: data.length } });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(ev));
    }

    const fileMatch = /^\/file\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && fileMatch) {
      const hit = await store.getFile(fileMatch[1]);
      if (!hit) {
        res.writeHead(404);
        return res.end();
      }
      hooks.onFileRead?.(decodeURIComponent(fileMatch[1]));
      res.writeHead(200, { "content-type": hit.type });
      return res.end(hit.data);
    }

    const json = /^\/(.+)\/json$/.exec(url.pathname);
    if (req.method === "GET" && json && url.searchParams.get("poll") === "1") {
      const topic = decodeURIComponent(json[1]);
      const since = url.searchParams.get("since") || "all";
      const refused = hooks.onPoll?.({ topic, since, poll: "1" });
      if (refused) {
        res.writeHead(refused.status, refused.headers || {});
        return res.end(refused.body);
      }
      const cursor = await store.resolve([topic], since);
      const out = await store.poll(topic, cursor.since);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const line = (ev) => JSON.stringify(cursor.reset ? { ...ev, reset: true } : ev);
      const keep = out.map(line);
      keep.push(line({ id: "keepalive", time: 0, event: "keepalive", topic }));
      return res.end(`${keep.join("\n")}\n`);
    }

    if (req.method === "GET" && json) {
      const names = json[1].split(",").map(decodeURIComponent);
      const since = url.searchParams.get("since") || "";
      hooks.onSubscribe?.({ topics: names, since });
      let cursor;
      try {
        cursor = await store.resolve(names, since);
      } catch {
        res.writeHead(500);
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache", "x-accel-buffering": "no" });
      res.write(`${JSON.stringify({ id: "open", time: 0, event: "open", topic: names.join(","), ...(cursor.reset ? { reset: true } : {}) })}\n`);
      let closed = false;
      // lastSeen only guards against a duplicate the store could hand us twice.
      let lastSeen = 0n;
      const send = (ev) => {
        if (closed || !names.includes(ev.topic)) return;
        const id = BigInt(ev.id);
        if (id <= lastSeen) return;
        lastSeen = id;
        res.write(`${JSON.stringify(ev)}\n`);
      };
      const keepalive = setInterval(() => {
        if (!closed) res.write(`${JSON.stringify({ id: "keepalive", time: 0, event: "keepalive", topic: names.join(",") })}\n`);
      }, 30_000);
      keepalive.unref?.();
      let unsubscribe = () => {};
      req.on("close", () => {
        closed = true;
        clearInterval(keepalive);
        unsubscribe();
      });
      // A store may await its backlog read, so a client that left meanwhile is unsubscribed on arrival.
      let stop;
      try {
        stop = await store.stream(names, cursor.since, send);
      } catch {
        clearInterval(keepalive);
        return res.end();
      }
      if (closed) stop();
      else unsubscribe = stop;
      return;
    }

    if (await threadRoute(store, req, res, url)) return;
    res.writeHead(404);
    res.end();
  });

  return {
    server,
    listen: (port = 0, host = "127.0.0.1") => new Promise((resolve) => server.listen(port, host, () => resolve(`http://${host}:${server.address().port}`))),
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** The production bundle: an opened store (Postgres in production) plus the server in front of it. */
export function openBus({ store, token = "", baseUrl = "" }) {
  if (!store) throw new Error("openBus: pass an opened store");
  const bus = createBusServer({ store, token, baseUrl });
  return {
    ...bus,
    store,
    prune: () => store.prune(),
    close: async () => { await bus.close(); await store.close(); },
  };
}
