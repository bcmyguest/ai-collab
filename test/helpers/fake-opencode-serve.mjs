#!/usr/bin/env node
// Fake `opencode serve` for the OpenShell tests: the OpenCode 2 routes the adapter calls, behind OPENCODE_SERVER_PASSWORD.
// It listens on a free port (not --port) and writes it to $HOME/.fake-opencode-port for fake-openshell-forward.mjs.
// Each request is appended to $HOME/.fake-opencode-calls.jsonl. A prompt runs one turn that answers "PONG".
import http from "node:http";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

if (process.argv[2] !== "serve") process.exit(0);
const home = process.env.HOME;
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD ?? ""}`).toString("base64")}`;
const streams = [];
const emit = (type, data) => { for (const res of streams) res.write(`data: ${JSON.stringify({ type, data })}\n\n`); };
let sessions = 0;

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  const body = raw ? JSON.parse(raw) : undefined;
  appendFileSync(join(home, ".fake-opencode-calls.jsonl"), `${JSON.stringify({ method: req.method, path: req.url, body })}\n`);
  const send = (code, value) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (!process.env.OPENCODE_SERVER_PASSWORD || req.headers.authorization !== auth) return send(401, { error: "unauthorized" });
  if (req.method === "GET" && req.url === "/api/info") return send(200, { version: "2.2.6" });
  if (req.method === "GET" && req.url === "/api/event") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": connected\n\n");
    streams.push(res);
    res.on("close", () => streams.splice(streams.indexOf(res), 1));
    return;
  }
  if (req.method === "POST" && req.url === "/api/session") return send(200, { data: { id: `ses_box${++sessions}` } });
  const session = /^\/api\/session\/([^/]+)(\/.*)?$/.exec(req.url);
  if (!session) return send(404, { error: "unscripted route" });
  const id = decodeURIComponent(session[1]);
  if (req.method === "GET" && !session[2]) return send(200, { data: { id, time: { created: 1, busy: 1, idle: 2 } } });
  if (req.method === "GET" && session[2] === "/permission") return send(200, { data: [] });
  if (req.method === "POST" && session[2] === "/prompt") {
    send(200, { data: { id: "msg_1" } });
    setTimeout(() => {
      emit("session.execution.started", { sessionID: id, executionID: "exe_1" });
      emit("session.text.ended", { sessionID: id, assistantMessageID: "msg_a", text: "PONG" });
      emit("session.execution.succeeded", { sessionID: id, executionID: "exe_1" });
    }, 20);
    return;
  }
  return send(404, { error: "unscripted route" });
});
server.listen(0, "127.0.0.1", () => {
  writeFileSync(join(home, ".fake-opencode-port"), String(server.address().port));
  process.stdout.write(`server listening on http://127.0.0.1:${server.address().port}\n`);
});
// A stale port file would point the next forward at a dead server.
process.on("SIGTERM", () => { rmSync(join(home, ".fake-opencode-port"), { force: true }); server.closeAllConnections(); server.close(() => process.exit(0)); });
