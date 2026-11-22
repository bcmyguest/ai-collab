// Client for the runner control socket, for the UI server and the CLI.
import http from "node:http";
import { runnerSocket } from "./control.mjs";

export const CLIENT_TIMEOUT_MS = 70_000;

/** One JSON request over the unix socket; resolves {status, body}; rejects when the runner is not listening. */
export function runnerRequest(method, path, body, { socket = runnerSocket(), timeoutMs = CLIENT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ socketPath: socket, method, path, timeout: timeoutMs, headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let value = null;
        try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: value });
      });
    });
    req.on("timeout", () => req.destroy(new Error("runner request timed out")));
    req.on("error", reject);
    req.end(data);
  });
}

const sessionPath = (address) => {
  const [harness, label] = String(address).split("#");
  return `/v1/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(label || "")}`;
};

/** Thin wrappers that name each control route. */
export const runnerClient = (options = {}) => ({
  health: () => runnerRequest("GET", "/v1/health", undefined, options),
  harnesses: () => runnerRequest("GET", "/v1/harnesses", undefined, options),
  models: (harness) => runnerRequest("GET", `/v1/harnesses/${encodeURIComponent(harness)}/models`, undefined, options),
  commands: (harness, project) => runnerRequest("GET", `/v1/harnesses/${encodeURIComponent(harness)}/commands?project=${encodeURIComponent(project)}`, undefined, options),
  sessions: () => runnerRequest("GET", "/v1/sessions", undefined, options),
  deliveries: () => runnerRequest("GET", "/v1/deliveries", undefined, options),
  schedules: () => runnerRequest("GET", "/v1/schedules", undefined, options),
  runSchedule: (name, caller = "client") => runnerRequest("POST", `/v1/schedules/${encodeURIComponent(name)}/run?caller=${encodeURIComponent(caller)}`, {}, options),
  start: (input) => runnerRequest("POST", "/v1/sessions", input, options),
  get: (address) => runnerRequest("GET", sessionPath(address), undefined, options),
  send: (address, text, { steer = false } = {}) => runnerRequest("POST", `${sessionPath(address)}/send`, { text, steer }, options),
  interrupt: (address) => runnerRequest("POST", `${sessionPath(address)}/interrupt`, {}, options),
  setMode: (address, mode) => runnerRequest("POST", `${sessionPath(address)}/mode`, { mode }, options),
  approve: (address, id, decision) => runnerRequest("POST", `${sessionPath(address)}/approvals/${encodeURIComponent(id)}`, decision, options),
  context: (address) => runnerRequest("GET", `${sessionPath(address)}/context`, undefined, options),
  close: (address) => runnerRequest("DELETE", sessionPath(address), undefined, options),
});

/** True when the runner answers its control socket; the UI dispatcher stands down while it does. */
export async function runnerUp(options = {}) {
  try {
    return (await runnerClient({ timeoutMs: 1000, ...options }).health()).status === 200;
  } catch {
    return false;
  }
}
