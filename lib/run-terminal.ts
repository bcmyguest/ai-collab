/**
 * Run in terminal: an agent proposes a script, the operator reads it in the UI and clicks Run, and the UI server runs it.
 * Requests live under <stateDir>/<project>/run-terminal/<id>/; decision.json is created once (O_EXCL), so a request runs
 * at most once. Nothing here reads the bus: the only path to decideRun is the UI server's authenticated HTTP route.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import type { Readable } from "node:stream";
import path from "node:path";
import { autoDefaults } from "./config.mjs";
import { readJson, writeFileAtomic } from "./store.ts";

// oxlint-disable-next-line typescript/no-explicit-any -- request, decision and result files are JSON any same-user process can write
type Json = any;
export type RunRequest = { id: string; project: string; session: string; script: string; cwd: string; reason: string; sha256: string; timeoutS: number; createdAt: number; expiresAt: number };
export type RunStatus = { id: string; sha256: string; expiresAt: string; status: string; by?: string; why?: string };
export type RunDecision = { id: string; status: string };
type RunCfg = { peer: string; session?: string; project: string; stateDir: string };
type Update = () => void;

export const RUN_ID = /^[a-f0-9]{24}$/;
export const SCRIPT_MAX_BYTES = 64 * 1024;
export const REASON_MAX = 300;
export const TIMEOUT_DEFAULT_S = 300;
export const TIMEOUT_MAX_S = 3600;
export const TTL_DEFAULT_S = 15 * 60;
const TTL_MAX_S = 60 * 60;
const CLOCK_SKEW_MS = 5000;
const TAIL_BYTES = 16 * 1024;
const FLUSH_MS = 250;
const KILL_GRACE_MS = 5000;
const LIST_MAX = 20;
const LIST_AGE_MS = 24 * 60 * 60 * 1000;
const ADDRESS = /^[a-z0-9-]{1,24}#[a-f0-9]{16}$/;
// Control, format, separator and default-ignorable characters other than tab, newline and space: they hide or fake bytes.
const HIDDEN = /(?![\t\n ])[\p{C}\p{Z}\p{Default_Ignorable_Code_Point}]/u;
// More blanks in a row than this can push the rest of a wrapped line out of the card's view.
const BLANK_RUN = /[ \t]{65}/;
// The UI server's own variables; a script gets the rest of its environment.
const SERVER_ENV = /^(AI_COLLAB_|NEXT_|__NEXT|NODE_ENV$|NODE_OPTIONS$)/;
// The request fields the card shows; a stored request that no longer matches what was shown cannot run.
export const SHOWN = ["session", "cwd", "reason", "script", "sha256", "timeoutS", "createdAt", "expiresAt"];
export const FINAL = ["done", "lost", "rejected", "expired", "refused"];

/** On when AI_COLLAB_RUN_IN_TERMINAL=1, or defaults.json sets "runInTerminal": true and the variable is not 0. */
export function runInTerminalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AI_COLLAB_RUN_IN_TERMINAL === "1") return true;
  if (env.AI_COLLAB_RUN_IN_TERMINAL === "0") return false;
  return (autoDefaults(env) as Json)?.runInTerminal === true;
}

/** False inside an OpenShell sandbox or a builder, where the tool is never offered. */
export const onHost = (env: NodeJS.ProcessEnv): boolean => !env.OPENSHELL_SANDBOX && !env.AI_COLLAB_BUILDER && !env.AI_COLLAB_SANDBOX_OUT;

export const sha256 = (script: string): string => createHash("sha256").update(script, "utf8").digest("hex");

/** Why a script cannot be shown byte for byte, or null. */
export function scriptProblem(script: unknown): string | null {
  if (typeof script !== "string" || !script.trim()) return "script must be non-empty text";
  if (!script.isWellFormed()) return "script must be valid Unicode";
  if (Buffer.byteLength(script, "utf8") > SCRIPT_MAX_BYTES) return `script exceeds ${SCRIPT_MAX_BYTES} bytes`;
  if (HIDDEN.test(script)) return "script contains control, bidi or zero-width characters the UI cannot show";
  if (BLANK_RUN.test(script)) return "script has a run of more than 64 blanks that could push text off screen";
  return null;
}

function cwdProblem(cwd: unknown): string | null {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || HIDDEN.test(cwd)) return "cwd must be an absolute path";
  try { if (!fs.statSync(cwd).isDirectory()) return "cwd is not a directory"; } catch { return "cwd does not exist"; }
  return null;
}

export const runRoot = (stateDir: string, project: string): string => path.join(stateDir, project, "run-terminal");
const dirOf = (stateDir: string, project: string, id: string) => path.join(runRoot(stateDir, project), id);
const auditFile = (stateDir: string) => path.join(stateDir, "run-terminal-audit.jsonl");

/** Appends one line to the audit log: every request, decision, refusal and finish. */
export function audit(stateDir: string, entry: Record<string, unknown>): void {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(auditFile(stateDir), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
}

/** Records a pending request for the operator to read; returns its id, hash and expiry. Throws on bad input or off the host. */
export function createRunRequest(cfg: RunCfg, { script, cwd, reason, timeoutS }: { script: string; cwd: string; reason: unknown; timeoutS?: unknown }, env: NodeJS.ProcessEnv = process.env, now: number = Date.now()) {
  if (!onHost(env)) throw new Error("run_in_terminal runs only on the host, not in a sandbox or builder");
  if (!runInTerminalEnabled(env)) throw new Error("run_in_terminal is off; set runInTerminal in defaults.json");
  const problem = scriptProblem(script) || cwdProblem(cwd);
  if (problem) throw new Error(problem);
  if (typeof reason !== "string" || !reason.trim() || reason.length > REASON_MAX || HIDDEN.test(reason)) throw new Error(`reason must be 1 to ${REASON_MAX} printable characters`);
  const timeout = timeoutS === undefined ? TIMEOUT_DEFAULT_S : timeoutS;
  if (!Number.isInteger(timeout) || (timeout as number) < 1 || (timeout as number) > TIMEOUT_MAX_S) throw new Error(`timeout_s must be 1 to ${TIMEOUT_MAX_S}`);
  const session = `${cfg.peer}#${cfg.session}`;
  if (!ADDRESS.test(session)) throw new Error("Pass the session label supplied by the ai-collab hook");
  const ttl = Math.min(Number(env.AI_COLLAB_RUN_TTL_S) || TTL_DEFAULT_S, TTL_MAX_S);
  const id = randomBytes(12).toString("hex");
  const request: RunRequest = { id, project: cfg.project, session, script, cwd, reason: reason.trim(), sha256: sha256(script), timeoutS: timeout as number, createdAt: now, expiresAt: now + ttl * 1000 };
  writeFileAtomic(path.join(dirOf(cfg.stateDir, cfg.project, id), "request.json"), `${JSON.stringify(request)}\n`);
  audit(cfg.stateDir, { event: "requested", id, project: cfg.project, session, sha256: request.sha256, cwd, timeoutS: timeout });
  return { id, status: "pending", sha256: request.sha256, expiresAt: new Date(request.expiresAt).toISOString() };
}

/**
 * The stored request, checked again: the file is writable by any same-user process, so its hash is recomputed and its
 * expiry is clamped to TTL_MAX_S after a creation time that is not in the future. Null when missing or malformed.
 */
export function readRunRequest(stateDir: string, project: string, id: string, now: number = Date.now()): RunRequest | null {
  if (!RUN_ID.test(id || "")) return null;
  const r = readJson<Json>(path.join(dirOf(stateDir, project, id), "request.json"));
  if (!r || r.id !== id || r.project !== project || !ADDRESS.test(r.session || "") || scriptProblem(r.script)) return null;
  if (typeof r.cwd !== "string" || !path.isAbsolute(r.cwd) || typeof r.reason !== "string") return null;
  if (!Number.isFinite(r.createdAt) || r.createdAt > now + CLOCK_SKEW_MS || !Number.isInteger(r.timeoutS) || r.timeoutS < 1 || r.timeoutS > TIMEOUT_MAX_S) return null;
  const expiresAt = Math.min(Number(r.expiresAt) || 0, r.createdAt + TTL_MAX_S * 1000);
  return { id, project, session: r.session, script: r.script, cwd: r.cwd, reason: r.reason.slice(0, REASON_MAX), sha256: sha256(r.script), timeoutS: r.timeoutS, createdAt: r.createdAt, expiresAt };
}

// Claims the request for one decision; false when another decision got there first.
function claim(stateDir: string, project: string, id: string, record: Record<string, unknown>): boolean {
  try {
    fs.writeFileSync(path.join(dirOf(stateDir, project, id), "decision.json"), `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

const readDecision = (stateDir: string, project: string, id: string) => readJson<Json>(path.join(dirOf(stateDir, project, id), "decision.json"));
const writeResult = (stateDir: string, project: string, id: string, result: Record<string, unknown>) => writeFileAtomic(path.join(dirOf(stateDir, project, id), "result.json"), `${JSON.stringify(result)}\n`);

/** Closes an unanswered request whose expiry passed, once, so later reads and clicks see "expired". */
function expireIfDue(request: RunRequest, stateDir: string, now: number): boolean {
  if (now <= request.expiresAt) return false;
  if (claim(stateDir, request.project, request.id, { decision: "expired", at: now })) {
    audit(stateDir, { event: "expired", id: request.id, project: request.project, session: request.session, sha256: request.sha256 });
  }
  return true;
}

/** Closes an undecided request as refused, once, with an audit line; false when it was already decided. */
export function closeRun(stateDir: string, project: string, id: string, why: string, by: string = "operator"): boolean {
  if (!claim(stateDir, project, id, { decision: "refused", why, by, at: Date.now() })) return false;
  audit(stateDir, { event: "refused", id, project, by, why });
  return true;
}

/** Marks runs the previous UI server left at running as lost: their process died with it. */
export function markLost(stateDir: string, project: string, now: number = Date.now()): void {
  for (const request of listRunRequests(stateDir, project, now).filter((item) => item.status === "running")) {
    const result = readJson<Json>(path.join(dirOf(stateDir, project, request.id), "result.json")) || {};
    writeResult(stateDir, project, request.id, { ...result, status: "lost", lostAt: now });
    audit(stateDir, { event: "lost", id: request.id, project, session: request.session, sha256: request.sha256 });
  }
}

/** Status and result of a request: pending, running, done, lost, rejected, expired or refused. */
export function runStatus(stateDir: string, project: string, id: string, now: number = Date.now()): RunStatus {
  const request = readRunRequest(stateDir, project, id, now);
  if (!request) throw new Error(`No run request ${id}`);
  let decision = readDecision(stateDir, project, id);
  if (!decision && expireIfDue(request, stateDir, now)) decision = readDecision(stateDir, project, id);
  const base = { id, sha256: request.sha256, expiresAt: new Date(request.expiresAt).toISOString() };
  if (!decision) return { ...base, status: "pending" };
  if (decision.decision === "run") {
    const result = readJson<Json>(path.join(dirOf(stateDir, project, id), "result.json")) || { status: "running" };
    return { ...base, ...result, status: ["done", "lost"].includes(result.status) ? result.status : "running", by: decision.by };
  }
  // oxlint-disable-next-line quality/no-known-value-widening -- looked up by the stored decision
  const status = ({ reject: "rejected", expired: "expired", refused: "refused" } as Record<string, string | undefined>)[decision.decision] || "refused";
  return { ...base, status, ...(decision.by ? { by: decision.by } : {}), ...(decision.why ? { why: decision.why } : {}) };
}

/** Polls the request until it reaches a final state, the deadline passes, or the signal aborts. */
export async function waitForRun(cfg: RunCfg, id: string, seconds: number = 25, signal?: AbortSignal): Promise<RunStatus> {
  const deadline = Date.now() + Math.max(0, Math.min(45, seconds)) * 1000;
  for (;;) {
    const status = runStatus(cfg.stateDir, cfg.project, id);
    if (FINAL.includes(status.status) || Date.now() >= deadline || signal?.aborted) return status;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Recent requests of a project, newest first, with status and script for the UI. */
export function listRunRequests(stateDir: string, project: string, now: number = Date.now()) {
  let ids: string[];
  try { ids = fs.readdirSync(runRoot(stateDir, project)).filter((id) => RUN_ID.test(id)); } catch { return []; }
  const out: Array<RunRequest & RunStatus & { expiresAt: number }> = [];
  for (const id of ids) {
    const request = readRunRequest(stateDir, project, id, now);
    if (!request || now - request.createdAt > LIST_AGE_MS) continue;
    out.push({ ...request, ...runStatus(stateDir, project, id, now), expiresAt: request.expiresAt } as RunRequest & RunStatus & { expiresAt: number });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, LIST_MAX);
}

const tail = (text: string) => {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= TAIL_BYTES ? text : bytes.subarray(bytes.length - TAIL_BYTES).toString("utf8");
};

/**
 * The operator's decision from the UI server. Run executes the stored bytes only when their recomputed sha256 equals
 * the hash the browser computed from what it showed, and, given the pinned fields the UI first showed, only when the
 * stored request still matches them; a mismatch closes the request. Returns the status at once; onUpdate fires as
 * output arrives and when the script ends.
 */
export function decideRun({ stateDir, project, id, decision, sha256: shown, pinned, by = "operator", onUpdate = () => {}, env = process.env, now = Date.now() }: {
  stateDir: string; project: string; id: string; decision: unknown; sha256?: unknown; pinned?: Json; by?: string; onUpdate?: Update; env?: NodeJS.ProcessEnv; now?: number;
}): RunDecision {
  const request = readRunRequest(stateDir, project, id, now);
  const fields = { id, project, session: request?.session, sha256: request?.sha256, by };
  const refuse = (why: string, status = 409, close = false): never => {
    // The request folder watch sees no write inside a request's own folder, so a closed card is pushed here.
    if (close && request && claim(stateDir, project, id, { decision: "refused", why, by, at: now })) onUpdate();
    audit(stateDir, { event: "refused", ...fields, why });
    const error: Error & { status?: number } = new Error(`Run refused: ${why}`);
    error.status = status;
    throw error;
  };
  if (!request) return refuse("unknown request", 404);
  if (!["run", "reject"].includes(decision as string)) refuse("unknown decision", 400);
  if (readDecision(stateDir, project, id)) refuse("already decided");
  if (expireIfDue(request, stateDir, now)) refuse("expired");
  if (decision === "reject") {
    if (!claim(stateDir, project, id, { decision: "reject", by, at: now })) refuse("already decided");
    audit(stateDir, { event: "rejected", ...fields, decision });
    onUpdate();
    return { id, status: "rejected" };
  }
  if (pinned && SHOWN.some((key) => pinned[key] !== request[key as keyof RunRequest])) refuse("the request changed after it was shown", 409, true);
  if (typeof shown !== "string" || shown !== request.sha256) refuse("the script hash does not match what was shown", 409, true);
  const problem = cwdProblem(request.cwd);
  if (problem) refuse(problem, 409, true);
  if (!claim(stateDir, project, id, { decision: "run", by, at: now })) refuse("already decided");
  audit(stateDir, { event: "run", ...fields, decision, cwd: request.cwd, script: request.script });
  execute(stateDir, request, by, onUpdate, env);
  return { id, status: "running" };
}

// Runs the request's script with bash in its cwd, as this process's user without its own variables, killing its process group at the timeout.
function execute(stateDir: string, request: RunRequest, by: string, onUpdate: Update, env: NodeJS.ProcessEnv): void {
  const startedAt = Date.now();
  const output = { stdout: "", stderr: "" };
  let timedOut = false;
  let flush: NodeJS.Timeout | null = null;
  let finished = false;
  const result = (extra: Json) => ({ status: "running", startedAt, stdoutTail: output.stdout, stderrTail: output.stderr, ...extra });
  const save = () => {
    flush = null;
    writeResult(stateDir, request.project, request.id, result({}));
    onUpdate();
  };
  writeResult(stateDir, request.project, request.id, result({}));
  const child = spawn("bash", ["--noprofile", "--norc", "-c", request.script], { cwd: request.cwd, env: Object.fromEntries(Object.entries(env).filter(([name]) => !SERVER_ENV.test(name))), stdio: ["ignore", "pipe", "pipe"], detached: true });
  const collect = (stream: Readable, key: "stdout" | "stderr") => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      output[key] = tail(output[key] + chunk);
      flush ??= setTimeout(save, FLUSH_MS);
    });
  };
  collect(child.stdout, "stdout");
  collect(child.stderr, "stderr");
  const kill = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal); } catch { /* the group already exited */ } };
  const timer = setTimeout(() => {
    timedOut = true;
    kill("SIGTERM");
    setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS).unref();
  }, request.timeoutS * 1000);
  const finish = (exitCode: number | null, signal: NodeJS.Signals | null, error: string | undefined) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    clearTimeout(flush ?? undefined);
    const finishedAt = Date.now();
    const done = result({ status: "done", exitCode, signal, timedOut, finishedAt, durationMs: finishedAt - startedAt, ...(error ? { error } : {}) });
    writeResult(stateDir, request.project, request.id, done);
    audit(stateDir, { event: "finished", id: request.id, project: request.project, session: request.session, sha256: request.sha256, by, exitCode, signal, timedOut, durationMs: done.durationMs });
    onUpdate();
  };
  child.on("error", (error) => finish(null, null, error.message));
  child.on("close", (code, signal) => finish(code, signal, undefined));
}
