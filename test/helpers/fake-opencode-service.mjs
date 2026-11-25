// Scripted OpenCode service for adapter tests: REST answers, a call log, and an SSE stream the test drives. Test-only; never the real service.
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PASSWORD = "test-password";
export const AUTH = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`;
const SESSION = "ses_test"; // the id POST /api/session returns

// The OpenCode 2.2.6 Session.Info shape: no status field, the turn state lives in time.busy and time.idle.
const timeOf = (state) => (state === "busy" ? { created: 1, updated: 2, busy: 2 } : { created: 1, updated: 2, busy: 1, idle: 2 });

/**
 * status: session id -> "idle" | "busy" (read on GET /api/session/:id); permissions: session id -> listed asks.
 * parents: child session id -> parent id, read on GET /api/session/:id.
 * holdReplies(true) parks permission reply POSTs until releaseReplies().
 */
export async function fakeOpencodeService({ status = {}, permissions = {}, parents = {} } = {}) {
  const state = mkdtempSync(path.join(os.tmpdir(), "ai-collab-opencode-fake-"));
  const calls = [];
  const streams = [];
  const held = [];
  let hold = false;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method, path: req.url, body, auth: req.headers.authorization });
    const send = (code, value) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== AUTH) return send(401, { error: "unauthorized" });
    if (req.method === "GET" && req.url === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      streams.push(res);
      res.on("close", () => { const at = streams.indexOf(res); if (at >= 0) streams.splice(at, 1); });
      return;
    }
    if (req.method === "POST" && req.url === "/api/session") return send(200, { data: { id: SESSION } });
    const session = /^\/api\/session\/([^/]+)(\/.*)?$/.exec(req.url);
    if (!session) return send(404, { error: "unscripted route" });
    const id = decodeURIComponent(session[1]);
    const rest = session[2] ?? "";
    if (req.method === "GET" && rest === "") return send(200, { data: { id, time: timeOf(status[id] ?? "idle"), ...(parents[id] ? { parentID: parents[id] } : {}) } });
    if (req.method === "GET" && rest === "/permission") return send(200, { data: permissions[id] ?? [] });
    if (req.method === "POST" && rest === "/prompt") return send(200, { data: { id: "msg_1" } });
    if (req.method === "POST" && /^\/permission\/[^/]+\/reply$/.test(rest)) {
      if (!hold) return send(200, {});
      held.push(() => send(200, {}));
      return;
    }
    return send(404, { error: "unscripted route" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  mkdirSync(path.join(state, "opencode"), { recursive: true });
  writeFileSync(path.join(state, "opencode", "service.json"), JSON.stringify({ url, password: PASSWORD }));
  return {
    env: { XDG_STATE_HOME: state, PATH: process.env.PATH },
    calls,
    streams,
    status,
    permissions,
    emit(event) { for (const res of streams) res.write(`data: ${JSON.stringify(event)}\n\n`); },
    // Ends every open event stream, as a dropped connection does.
    dropStreams() { for (const res of [...streams]) res.end(); },
    holdReplies(on) { hold = on; },
    releaseReplies() { for (const reply of held.splice(0)) reply(); },
    count(method, path) { return calls.filter((c) => c.method === method && c.path === path).length; },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(state, { recursive: true, force: true });
    },
  };
}
