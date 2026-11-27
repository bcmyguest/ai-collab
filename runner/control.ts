// Control API: HTTP/1.1 JSON over a 0600 unix socket; routes are listed in docs/owned-sessions-contract.md.
import http, { type IncomingMessage, type Server } from "node:http";
import net from "node:net";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { SESSION_LABEL } from "../lib/config.ts";
import { HARNESSES } from "./contract.ts";

export const MAX_REQUEST_BYTES = 64 * 1024;
const VERSION = 1;

// oxlint-disable-next-line typescript/no-explicit-any -- request bodies and runner answers are JSON on the control socket
type Json = any;
type Awaitable<T> = T | Promise<T>;
/** The runner methods the control routes call (runner/runner.mjs). */
export interface ControlRunner {
  harnesses(): Awaitable<Array<{ harness: string } & Json>>;
  startPattern(input: Json): Awaitable<Json>;
  advancePattern(input: Json): Awaitable<Json>;
  schedules(): Awaitable<Json>;
  scheduleRuns(name: string): Awaitable<Json>;
  runSchedule(name: string, caller: string): Awaitable<Json>;
  models(harness: string): Awaitable<Json>;
  commands(harness: string, project: string): Awaitable<Json>;
  deliveries(): Awaitable<Json>;
  continueBuilder(input: Json): Awaitable<Json>;
  list(): Json;
  start(input: Json): Awaitable<Json>;
  get(target: string): Json;
  close(target: string): Awaitable<Json>;
  context(target: string): Awaitable<Json>;
  send(target: string, msg: { text: unknown; steer: boolean }): Awaitable<Json>;
  closeChild(target: string, parent: unknown): Awaitable<Json>;
  interrupt(target: string): Awaitable<Json>;
  compact(target: string): Awaitable<Json>;
  setModel(target: string, model: unknown): Awaitable<Json>;
  setMode(target: string, mode: unknown): Awaitable<Json>;
  respond(target: string, id: string, answer: { decision: unknown; answers?: unknown }): Awaitable<Json>;
}
type HttpError = Error & { status?: unknown };

export { runnerSocket } from "../lib/runner-request.ts";

const fail: (status: number, message: string) => never = (status, message) => { throw Object.assign(new Error(message), { status }); };

// The caller label a client sends as ?caller=, reduced to 80 safe characters for the log.
const callerOf = (url: URL) => String(url.searchParams.get("caller") || "").replace(/[^\w.:@/-]/g, "").slice(0, 80) || "unknown";

async function body(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
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
function address(harness: string, label: string | undefined): string {
  if (!HARNESSES.includes(harness) || !SESSION_LABEL.test(label || "")) fail(400, "Invalid session address");
  return `${harness}#${label}`;
}

/** Dispatches one request to the runner; resolves [status, value]. */
export async function route(runner: ControlRunner, method: string | undefined, url: URL, input: Json): Promise<[number, Json]> {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "v1") fail(404, "Not found");
  const [, area, a, b, action, id] = parts;
  if (area === "health" && method === "GET") return [200, { ok: true, version: VERSION, harnesses: (await runner.harnesses()).map((h) => h.harness) }];
  if (area === "pattern-runs" && method === "POST" && !b) {
    if (!a) return [201, await runner.startPattern(input)];
    if (a === "advance") return [200, await runner.advancePattern(input)];
  }
  if (area === "schedules") {
    if (!a && method === "GET") return [200, await runner.schedules()];
    if (a && b === "runs" && !action) {
      if (method !== "GET") fail(405, "Method not allowed");
      return [200, await runner.scheduleRuns(a)];
    }
    if (a && b === "run" && !action) {
      if (method !== "POST") fail(405, "Method not allowed");
      return [202, await runner.runSchedule(a, callerOf(url))];
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
  if (area === "deliveries") {
    if (method !== "GET") fail(405, "Method not allowed");
    return [200, await runner.deliveries()];
  }
  if (area === "builder-continuations" && !a && method === "POST") return [201, await runner.continueBuilder(input)];
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
  if (action === "close-child") return [200, await runner.closeChild(target, input.parent)];
  if (action === "interrupt") return [202, await runner.interrupt(target)];
  // Real in-place compaction through the harness's own trigger (Claude /compact, Codex thread/compact/start, OpenCode
  // session.compact); 409 when the session is mid-turn, "unsupported" when the harness has no outside trigger.
  if (action === "compact") return [200, await runner.compact(target)];
  if (action === "model") return [200, await runner.setModel(target, input.model)];
  if (action === "mode") return [200, await runner.setMode(target, input.mode)];
  if (action === "approvals" && /^[a-f0-9]{12}$/.test(id || "")) return [200, await runner.respond(target, id, { decision: input.decision, ...(input.answers ? { answers: input.answers } : {}) })];
  fail(404, "Not found");
}

// Resolves true when something already accepts connections on the socket path.
function socketLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(path);
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => resolve(false));
  });
}

/** Listens on the unix socket; refuses to replace a live runner. Resolves {server, path, close}. */
export async function listenControl(runner: ControlRunner, path: string): Promise<{ server: Server; path: string; close: () => Promise<void> }> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  if (await socketLive(path)) throw new Error(`another runner listens on ${path}`);
  rmSync(path, { force: true });
  const server = http.createServer(async (req, res) => {
    let status: number;
    let value: Json;
    try {
      const url = new URL(req.url as string, "http://runner.invalid");
      [status, value] = await route(runner, req.method, url, ["POST", "PUT"].includes(req.method as string) ? await body(req) : {});
    } catch (error) {
      status = Number.isInteger((error as HttpError).status) ? (error as HttpError).status as number : 500;
      value = { error: status === 500 ? "Runner error" : (error as HttpError).message };
    }
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(value));
  });
  // The umask makes the socket 0600 from its first moment; the chmod below is the backstop.
  const mask = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
  } finally {
    process.umask(mask);
  }
  chmodSync(path, 0o600);
  return {
    server, path,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => { rmSync(path, { force: true }); resolve(); });
    }),
  };
}
