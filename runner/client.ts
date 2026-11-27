// Client for the runner control socket, for the UI server and the CLI.
import { runnerRequest } from "../lib/runner-request.ts";
export { CLIENT_TIMEOUT_MS, runnerRequest } from "../lib/runner-request.ts";

type ClientOptions = { socket?: string; timeoutMs?: number };

const sessionPath = (address: unknown): string => {
  const [harness, label] = String(address).split("#");
  return `/v1/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(label || "")}`;
};

/** Thin wrappers that name each control route. */
export const runnerClient = (options: ClientOptions = {}) => ({
  startPattern: (input: unknown) => runnerRequest("POST", "/v1/pattern-runs", input, options),
  advancePattern: (input: unknown) => runnerRequest("POST", "/v1/pattern-runs/advance", input, options),
  health: () => runnerRequest("GET", "/v1/health", undefined, options),
  harnesses: () => runnerRequest("GET", "/v1/harnesses", undefined, options),
  models: (harness: string) => runnerRequest("GET", `/v1/harnesses/${encodeURIComponent(harness)}/models`, undefined, options),
  commands: (harness: string, project: string) => runnerRequest("GET", `/v1/harnesses/${encodeURIComponent(harness)}/commands?project=${encodeURIComponent(project)}`, undefined, options),
  sessions: () => runnerRequest("GET", "/v1/sessions", undefined, options),
  deliveries: () => runnerRequest("GET", "/v1/deliveries", undefined, options),
  schedules: () => runnerRequest("GET", "/v1/schedules", undefined, options),
  runSchedule: (name: string, caller = "client") => runnerRequest("POST", `/v1/schedules/${encodeURIComponent(name)}/run?caller=${encodeURIComponent(caller)}`, {}, options),
  continueBuilder: (input: unknown) => runnerRequest("POST", "/v1/builder-continuations", input, options),
  start: (input: unknown) => runnerRequest("POST", "/v1/sessions", input, options),
  get: (address: string) => runnerRequest("GET", sessionPath(address), undefined, options),
  send: (address: string, text: string, { steer = false }: { steer?: boolean } = {}) => runnerRequest("POST", `${sessionPath(address)}/send`, { text, steer }, options),
  interrupt: (address: string) => runnerRequest("POST", `${sessionPath(address)}/interrupt`, {}, options),
  compact: (address: string) => runnerRequest("POST", `${sessionPath(address)}/compact`, {}, options),
  setModel: (address: string, model: string) => runnerRequest("POST", `${sessionPath(address)}/model`, { model }, options),
  setMode: (address: string, mode: string) => runnerRequest("POST", `${sessionPath(address)}/mode`, { mode }, options),
  approve: (address: string, id: string, decision: unknown) => runnerRequest("POST", `${sessionPath(address)}/approvals/${encodeURIComponent(id)}`, decision, options),
  context: (address: string) => runnerRequest("GET", `${sessionPath(address)}/context`, undefined, options),
  close: (address: string) => runnerRequest("DELETE", sessionPath(address), undefined, options),
});

/** True when the runner answers its control socket; the UI dispatcher stands down while it does. */
export async function runnerUp(options: ClientOptions = {}): Promise<boolean> {
  try {
    return (await runnerClient({ timeoutMs: 1000, ...options }).health()).status === 200;
  } catch {
    return false;
  }
}
