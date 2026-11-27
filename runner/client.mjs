// Client for the runner control socket, for the UI server and the CLI.
import { runnerRequest } from "../lib/runner-request.ts";
export { CLIENT_TIMEOUT_MS, runnerRequest } from "../lib/runner-request.ts";

const sessionPath = (address) => {
  const [harness, label] = String(address).split("#");
  return `/v1/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(label || "")}`;
};

/** Thin wrappers that name each control route. */
export const runnerClient = (options = {}) => ({
  startPattern: (input) => runnerRequest("POST", "/v1/pattern-runs", input, options),
  advancePattern: (input) => runnerRequest("POST", "/v1/pattern-runs/advance", input, options),
  health: () => runnerRequest("GET", "/v1/health", undefined, options),
  harnesses: () => runnerRequest("GET", "/v1/harnesses", undefined, options),
  models: (harness) => runnerRequest("GET", `/v1/harnesses/${encodeURIComponent(harness)}/models`, undefined, options),
  commands: (harness, project) => runnerRequest("GET", `/v1/harnesses/${encodeURIComponent(harness)}/commands?project=${encodeURIComponent(project)}`, undefined, options),
  sessions: () => runnerRequest("GET", "/v1/sessions", undefined, options),
  deliveries: () => runnerRequest("GET", "/v1/deliveries", undefined, options),
  schedules: () => runnerRequest("GET", "/v1/schedules", undefined, options),
  runSchedule: (name, caller = "client") => runnerRequest("POST", `/v1/schedules/${encodeURIComponent(name)}/run?caller=${encodeURIComponent(caller)}`, {}, options),
  continueBuilder: (input) => runnerRequest("POST", "/v1/builder-continuations", input, options),
  start: (input) => runnerRequest("POST", "/v1/sessions", input, options),
  get: (address) => runnerRequest("GET", sessionPath(address), undefined, options),
  send: (address, text, { steer = false } = {}) => runnerRequest("POST", `${sessionPath(address)}/send`, { text, steer }, options),
  interrupt: (address) => runnerRequest("POST", `${sessionPath(address)}/interrupt`, {}, options),
  compact: (address) => runnerRequest("POST", `${sessionPath(address)}/compact`, {}, options),
  setModel: (address, model) => runnerRequest("POST", `${sessionPath(address)}/model`, { model }, options),
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
