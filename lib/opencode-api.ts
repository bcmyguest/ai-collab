/**
 * Client for the local OpenCode service API (OpenCode 2). The endpoint comes from
 * $XDG_STATE_HOME/opencode/service.json ({url, password, pid}), the same file Pulsar reads; only loopback URLs are used.
 * A `--standalone` OpenCode has no service, so every call then reports ok: false.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/?$/;
const TIMEOUT_MS = 20_000;

// oxlint-disable-next-line typescript/no-explicit-any -- response bodies are OpenCode service JSON
type Json = any;
export type OpencodeEndpoint = { url: string; auth: string };
export type OpencodeResult = { ok: true; status: number; body: Json; error?: undefined } | { ok: false; status: number | null; error: string; body?: undefined };
export type OpencodeOptions = { body?: unknown; env?: NodeJS.ProcessEnv; fetchFn?: typeof fetch; timeoutMs?: number };

/** The service's {url, auth} from its state file, or null when no service runs. */
export function serviceEndpoint(env: NodeJS.ProcessEnv = process.env): OpencodeEndpoint | null {
  const state = env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state");
  try {
    const s = JSON.parse(readFileSync(join(state, "opencode", "service.json"), "utf8"));
    if (typeof s.url !== "string" || !LOOPBACK.test(s.url)) return null;
    const auth = typeof s.password === "string" && s.password ? `Basic ${Buffer.from(`opencode:${s.password}`).toString("base64")}` : "";
    return { url: s.url.replace(/\/$/, ""), auth };
  } catch {
    return null;
  }
}

/** One request to the service: {ok, status, body} or {ok: false, status, error}. */
export async function opencodeRequest(method: string, path: string, { body, env = process.env, fetchFn = fetch, timeoutMs = TIMEOUT_MS }: OpencodeOptions = {}): Promise<OpencodeResult> {
  const ep = serviceEndpoint(env);
  if (!ep) return { ok: false, status: null, error: "OpenCode service is not running" };
  try {
    const res = await fetchFn(ep.url + path, {
      method,
      headers: { ...(ep.auth ? { authorization: ep.auth } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: `${res.status} ${text.slice(0, 200)}` };
    try { return { ok: true, status: res.status, body: text ? JSON.parse(text) : null }; } catch { return { ok: true, status: res.status, body: text }; }
  } catch (error) {
    return { ok: false, status: null, error: (error as Error).name === "TimeoutError" ? "timed out" : "request failed" };
  }
}

/** Session ids with a running turn, or null when the service is unreachable. */
export async function activeOpencodeSessions(options?: OpencodeOptions): Promise<Set<string> | null> {
  const r = await opencodeRequest("GET", "/api/session/active", options);
  if (!r.ok) return null;
  return new Set(Object.keys(r.body?.data ?? r.body ?? {}));
}
