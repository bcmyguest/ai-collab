/**
 * In-process fake of the ntfy endpoints used by the plugin:
 *   POST /                       JSON publish {topic, message, title}
 *   GET  /<topic>/json?poll=1&since=...   cached NDJSON read
 *   GET  /<topic1>,<topic2>/json?since=...  streaming NDJSON subscription
 * No network beyond 127.0.0.1, no API keys, no agents.
 */
import http from "node:http";

export async function startFakeNtfy({ token = "" } = {}) {
  const topics = new Map();
  const streams = new Set();
  const state = {
    seq: 0,
    publishes: [],
    polls: [],
    subscribes: [],
    requests: 0,
    failNext: 0,
    limitNext: 0,
    delayMs: 0,
    files: new Map(),
  };

  const push = (topic, message, title = "", attachment) => {
    state.seq += 1;
    const ev = {
      id: `m${String(state.seq).padStart(8, "0")}`,
      time: Math.floor(Date.now() / 1000),
      event: "message",
      topic,
      message,
      title,
      ...(attachment ? { attachment } : {}),
    };
    if (!topics.has(topic)) topics.set(topic, []);
    topics.get(topic).push(ev);
    for (const stream of streams) if (stream.topics.includes(topic)) stream.res.write(`${JSON.stringify(ev)}\n`);
    return ev;
  };

  const server = http.createServer(async (req, res) => {
    state.requests += 1;
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    if (state.failNext > 0) {
      state.failNext -= 1;
      res.writeHead(500);
      return res.end("injected failure");
    }
    const url = new URL(req.url, "http://fake.invalid");

    if (req.method === "POST" && url.pathname === "/") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
        res.writeHead(400);
        return res.end("bad json");
      }
      if (typeof body.topic !== "string" || typeof body.message !== "string") {
        res.writeHead(400);
        return res.end("missing topic or message");
      }
      const ev = push(body.topic, body.message, body.title || "");
      state.publishes.push({
        topic: body.topic,
        message: body.message,
        title: body.title || "",
        auth: req.headers.authorization || "",
      });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(ev));
    }

    // PUT /<topic>?message=&title=&filename= with the file as body, like ntfy attachments.
    const put = url.pathname.match(/^\/([^/]+)$/);
    if (req.method === "PUT" && put) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const data = Buffer.concat(chunks);
      const name = url.searchParams.get("filename") || "file";
      const file = `f${state.files.size + 1}${name.slice(name.lastIndexOf("."))}`;
      const type = /\.png$/i.test(name) ? "image/png" : /\.jpe?g$/i.test(name) ? "image/jpeg" : /\.txt$/i.test(name) ? "text/plain; charset=utf-8" : "application/octet-stream";
      state.files.set(file, { data, type });
      const topic = decodeURIComponent(put[1]);
      // Like ntfy, a query-string message turns the two characters \n into a newline.
      const message = (url.searchParams.get("message") || "").replaceAll("\\n", "\n");
      const ev = push(topic, message, url.searchParams.get("title") || "", { name, type, size: data.length, url: `${baseUrl()}/file/${file}` });
      state.publishes.push({ topic, message, title: url.searchParams.get("title") || "", auth: req.headers.authorization || "", attachment: { name, size: data.length } });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(ev));
    }
    const fileMatch = url.pathname.match(/^\/file\/([^/]+)$/);
    if (req.method === "GET" && fileMatch && state.files.has(fileMatch[1])) {
      const { data, type } = state.files.get(fileMatch[1]);
      res.writeHead(200, { "content-type": type });
      return res.end(data);
    }

    const m = url.pathname.match(/^\/(.+)\/json$/);
    if (req.method === "GET" && m && url.searchParams.get("poll") !== "1") {
      const names = m[1].split(",").map(decodeURIComponent);
      const since = url.searchParams.get("since") || "";
      state.subscribes.push({ topics: names, since });
      const all = names.flatMap((name) => topics.get(name) || []).sort((a, b) => a.id.localeCompare(b.id));
      let out = [];
      if (since === "all") out = all;
      else if (/^\d{9,}$/.test(since)) out = all.filter((e) => e.time >= Number(since));
      else if (since) out = all.filter((e) => e.id > since);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ id: "open", time: 0, event: "open", topic: names.join(",") })}\n`);
      for (const e of out) res.write(`${JSON.stringify(e)}\n`);
      const stream = { topics: names, res };
      streams.add(stream);
      req.on("close", () => streams.delete(stream));
      return;
    }
    if (req.method === "GET" && m) {
      const topic = decodeURIComponent(m[1]);
      const since = url.searchParams.get("since") || "all";
      state.polls.push({ topic, since, poll: url.searchParams.get("poll") });
      if (state.limitNext > 0) {
        state.limitNext -= 1;
        res.writeHead(429, { "content-type": "application/json" });
        return res.end(JSON.stringify({ code: 42905, http: 429, error: "limit reached: daily bandwidth reached" }));
      }
      const all = topics.get(topic) || [];
      let out;
      if (since === "all" || /^\d+h$/.test(since)) out = all;
      else if (/^\d{9,}$/.test(since)) out = all.filter((e) => e.time >= Number(since));
      else {
        const idx = all.findIndex((e) => e.id === since);
        out = idx >= 0 ? all.slice(idx + 1) : all; // unknown id: return everything (dedup must cope)
      }
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const keep = out.map((e) => JSON.stringify(e));
      keep.push(JSON.stringify({ id: "keepalive", time: 0, event: "keepalive", topic }));
      return res.end(`${keep.join("\n")}\n`);
    }

    res.writeHead(404);
    res.end();
  });

  const baseUrl = () => `http://127.0.0.1:${server.address().port}`;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    inject: (topic, message) => push(topic, message),
    close: () => new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}
