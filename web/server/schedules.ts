// Read-only runner schedules for the UI: the control socket's GET routes; offline when no runner answers.
import { runnerRequest } from "../../runner/client.ts";
import { listProjects } from "../../lib/config.ts";
import { projectOfFolder } from "../../lib/schedule-session.ts";

const READ_TIMEOUT_MS = 2000;

// oxlint-disable-next-line typescript/no-explicit-any -- runner replies are JSON
type Json = any;
type RequestOptions = { socket?: string; timeoutMs?: number };
/** The runner's schedule list, or offline when its socket does not answer. */
export type Schedules = { status: "up" | "offline"; schedules?: Json[]; configError?: Json };

/** The runner's schedules as {status: "up", schedules, configError}, or {status: "offline"} when its socket does not answer. */
export async function readSchedules(options: RequestOptions = {}): Promise<Schedules> {
  try {
    const { status, body } = await runnerRequest("GET", "/v1/schedules", undefined, { timeoutMs: READ_TIMEOUT_MS, ...options });
    return status === 200 ? { status: "up", ...body } : { status: "offline" };
  } catch {
    return { status: "offline" };
  }
}

/**
 * The latest runs of one schedule; rejects with status 503 when the runner is offline. Each run carries the project
 * its schedule's folder belongs to, so the UI opens the timeline where that run's session publishes.
 */
export async function readScheduleRuns(name: string, { env = process.env, ...options }: RequestOptions & { env?: NodeJS.ProcessEnv } = {}): Promise<Json[]> {
  let response: Awaited<ReturnType<typeof runnerRequest>>;
  try {
    response = await runnerRequest("GET", `/v1/schedules/${encodeURIComponent(name)}/runs`, undefined, { timeoutMs: READ_TIMEOUT_MS, ...options });
  } catch {
    throw Object.assign(new Error("runner offline"), { status: 503 });
  }
  if (response.status !== 200) throw Object.assign(new Error(response.body?.error || "Runner error"), { status: response.status });
  const runs: Json[] = Array.isArray(response.body) ? response.body : [];
  if (!runs.length) return runs;
  // The schedule's folder names its project; without one a run still lists, it just links to no timeline.
  const listed = await readSchedules(options);
  const cwd = (listed.schedules || []).find((item: Json) => item.name === name)?.cwd || "";
  const project = projectOfFolder(cwd, listProjects(env));
  return project ? runs.map((run) => ({ ...run, project })) : runs;
}
