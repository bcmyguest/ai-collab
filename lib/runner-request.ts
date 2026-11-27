// Local runner transport shared with the dependency-free CLI and MCP plugin.
import http from "node:http";
import { join } from "node:path";
import { stateDir } from "./config.mjs";

/** The control socket path: AI_COLLAB_RUNNER_SOCKET, else $XDG_RUNTIME_DIR/ai-collab/runner.sock, else the state dir. */
export function runnerSocket(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AI_COLLAB_RUNNER_SOCKET) return env.AI_COLLAB_RUNNER_SOCKET;
  return env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "ai-collab", "runner.sock") : join(stateDir(env), "runner.sock");
}

export const CLIENT_TIMEOUT_MS = 70_000;

/** The runner's reply: the HTTP status and the parsed JSON body, or null when the body is not JSON. */
// oxlint-disable-next-line typescript/no-explicit-any -- the runner's JSON reply; callers read their own fields
type Json = any;

export interface RunnerResponse {
  status: number | undefined;
  body: Json;
}

/** One JSON request over the unix socket; resolves {status, body}; rejects when the runner is not listening. */
export function runnerRequest(method: string, path: string, body?: unknown, { socket = runnerSocket(), timeoutMs = CLIENT_TIMEOUT_MS }: { socket?: string; timeoutMs?: number } = {}): Promise<RunnerResponse> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ socketPath: socket, method, path, timeout: timeoutMs, headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let value: Json = null;
        try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: value });
      });
    });
    req.on("timeout", () => req.destroy(new Error("runner request timed out")));
    req.on("error", reject);
    req.end(data);
  });
}
