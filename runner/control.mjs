// Control API: HTTP/1.1 JSON over a 0600 unix socket; routes are listed in docs/owned-sessions-contract.md.
import http from "node:http";
import net from "node:net";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { SESSION_LABEL, stateDir } from "../lib/config.mjs";
import { HARNESSES } from "./contract.mjs";

export const MAX_REQUEST_BYTES = 64 * 1024;
const VERSION = 1;

/** The control socket path: AI_COLLAB_RUNNER_SOCKET, else $XDG_RUNTIME_DIR/ai-collab/runner.sock, else the state dir. */
export function runnerSocket(env = process.env) {
  if (env.AI_COLLAB_RUNNER_SOCKET) return env.AI_COLLAB_RUNNER_SOCKET;
  return env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "ai-collab", "runner.sock") : join(stateDir(env), "runner.sock");
}

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) fail(413, "Request too large");
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* falls through */ }
  fail(400, "Expected a JSON object");
}

// "/v1/sessions/<harness>/<label>" parts → the session address, or a 400.
function address(harness, label) {
  if (!HARNESSES.includes(harness) || !SESSION_LABEL.test(label || "")) fail(400, "Invalid session address");
  return `${harness}#${label}`;
}

/** Dispatches one request to the runner; resolves [status, value]. */
export async function route(runner, method, url, input) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "v1") fail(404, "Not found");
  const [, area, a, b, action, id] = parts;
  if (area === "health" && method === "GET") return [200, { ok: true, version: VERSION, harnesses: (await runner.harnesses()).map((h) => h.harness) }];
  if (area === "schedules") {
    if (!a && method === "GET") return [200, { schedules: runner.schedules() }];
    if (a && b === "run" && !action) {
      if (method !== "POST") fail(405, "Method not allowed");
      return [202, runner.runSchedule(a)];
    }
    fail(404, "Not found");
  }
  if (area === "harnesses") {
    if (method !== "GET") fail(405, "Method not allowed");
    if (!a) return [200, { harnesses: await runner.harnesses() }];
    if (!HARNESSES.includes(a)) fail(400, "Unknown harness");
    if (b === "models") return [200, { models: await runner.models(a) }];
    if (b === "commands") return [200, { commands: await runner.commands(a, url.searchParams.get("project") || "") }];
    fail(404, "Not found");
  }
  if (area !== "sessions") fail(404, "Not found");
  if (!a) {
    if (method === "GET") return [200, { sessions: runner.list() }];
    if (method === "POST") return [201, await runner.start(input)];
    fail(405, "Method not allowed");
  }
  const target = address(a, b);
  if (!action) {
    if (method === "GET") return [200, runner.get(target)];
    if (method === "DELETE") return [200, await runner.close(target)];
    fail(405, "Method not allowed");
  }
  if (action === "context" && method === "GET") return [200, { context: await runner.context(target) }];
  if (method !== "POST") fail(405, "Method not allowed");
  if (action === "send") return [202, await runner.send(target, { text: input.text, steer: input.steer === true })];
  if (action === "interrupt") return [202, await runner.interrupt(target)];
  if (action === "mode") return [200, await runner.setMode(target, input.mode)];
  if (action === "approvals" && /^[a-f0-9]{12}$/.test(id || "")) return [200, await runner.respond(target, id, { decision: input.decision, ...(input.answers ? { answers: input.answers } : {}) })];
  fail(404, "Not found");
}

// Resolves true when something already accepts connections on the socket path.
function socketLive(path) {
  return new Promise((resolve) => {
    const probe = net.connect(path);
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => resolve(false));
  });
}

/** Listens on the unix socket; refuses to replace a live runner. Resolves {server, path, close}. */
export async function listenControl(runner, path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (await socketLive(path)) throw new Error(`another runner listens on ${path}`);
  rmSync(path, { force: true });
  const server = http.createServer(async (req, res) => {
    let status;
    let value;
    try {
      const url = new URL(req.url, "http://runner.invalid");
      [status, value] = await route(runner, req.method, url, ["POST", "PUT"].includes(req.method) ? await body(req) : {});
    } catch (error) {
      status = Number.isInteger(error.status) ? error.status : 500;
      value = { error: status === 500 ? "Runner error" : error.message };
    }
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(value));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  chmodSync(path, 0o600);
  return {
    server, path,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => { rmSync(path, { force: true }); resolve(); });
    }),
  };
}
