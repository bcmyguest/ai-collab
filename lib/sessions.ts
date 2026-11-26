// Session registry and lifecycle: registry entries, owned records, display names, interrupt, control runs, scoped spawns and launch.
import { execFile, execFileSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { listProjects, SESSION_LABEL, sessionLabel, startPlaceSetting } from "./config.mjs";
import { CLIENT, codexCompact, codexLiveCompact, connect } from "./codex-compact.mjs";
import { codexRequiredRunCodeArgs, REQUIRE_RUN_CODE_ENV, resolveCodeMode } from "./code-mode.mjs";
import { hostAgentRefusal } from "./agent-guard.mjs";
import { sendMessage } from "./inbox.mjs";
import { runningJobs } from "./job.mjs";
import { stripControl } from "./format.mjs";
import { isRunning } from "./process.mjs";
import { opencodeRequest } from "./opencode-api.mjs";
import { runnerSocket } from "./runner-request.mjs";
import { SYSTEM_PROMPT_ENV } from "./machine-prompt.mjs";
import { WAKE_ENV, WAKE_PROMPT } from "./mode.mjs";
import { withLock, writeState } from "./state.mjs";
import { isProjectPaused, PROJECT_PAUSED } from "./project-pause.ts";
import { argv, CODEX_HOOK_TRUST, CURSOR_BINARIES, childPath, cursorCommandFor, HARNESSES, LAUNCH_BINARY, modelShape, type Command, type Harness } from "./harness.ts";
import { modeFlags } from "../web/lib/start-mode.js";

export type Proc = { pid: number; start: string };
export type Identity = { name?: string; activity?: string; tags?: string[] };
export type Session = Identity & {
  id: string;
  sessionId: string;
  cwd: string;
  harness: string;
  event?: string;
  seenAt?: number;
  model?: string;
  requireRunCode?: boolean;
  pid?: number;
  pidStart?: string;
  lastOperatorPromptAt?: number;
  parent?: string;
  parentNotifiedAt?: number;
  identityName?: string;
  sandbox?: boolean;
  peer?: string;
  session?: string;
  runningJobs?: unknown;
  online?: boolean;
};
export type OwnedStatus = "starting" | "idle" | "running" | "ended";
export type OwnedRecord = { v: 1; label: string; status: OwnedStatus; updatedAt: number; [field: string]: unknown };
export type SessionCfg = { stateDir: string; project: string; peer: string; session: string; peers: string[]; root?: string; auto?: boolean; enabled?: boolean };
export type Outcome = { status: string; detail: string };
export type ScopeVerdict = { ok: boolean; why: string; at?: number };
export type CodexRpcOptions = { cwd?: string; env?: NodeJS.ProcessEnv; command?: Command };
export type CodexLive = (threadId: string, options: CodexRpcOptions) => Promise<{ status: string }>;
export type CodexCall = (threadId: string, options: CodexRpcOptions) => Promise<unknown>;
export type LaunchStart = { file: string; args: string[]; scoped: boolean; unit: string; why: string };

const ACTIVITY_MAX = 200;
const TAGS_MAX = 10;
const TAG = /^[a-zA-Z0-9:./#_-]{1,40}$/;
const ADDRESS = /^[a-z0-9-]+#[a-f0-9]{16}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,39}$/;
const MODEL = /^[a-zA-Z0-9._:/#+-]{1,120}$/;
const REGISTRY_FILE = /^[a-z0-9-]+#[a-f0-9]{16}\.json$/;
const OWNED_LABEL_FILE = /^[a-f0-9]{16}\.json$/;
export const OWNED_STATUSES: readonly OwnedStatus[] = ["starting", "idle", "running", "ended"];

export const NAME_MAX = 80;
const INDEX_TAIL_BYTES = 256 * 1024;
// A worktree or subagent label such as agent-a3c26b3960e76171e repeats the address and names nothing.
export const MACHINE_NAME = /^agent-[0-9a-f]{8,}$/i;

// How to continue a session headless with a new prompt; resumed runs deliver queued messages through their hooks.
// Codex's run carries CODEX_HOOK_TRUST and --skip-git-repo-check, or a run in a fresh worktree fires no hooks.
const RESUME: Record<string, (id: string, requireRunCode: boolean) => string> = {
  claude: (id) => `claude -p --resume ${id} "<prompt>"`,
  codex: (id, requireRunCode) => {
    const settings = requireRunCode
      ? codexRequiredRunCodeArgs().map((arg) => ` '${arg.replaceAll("'", `'"'"'`)}'`).join("")
      : "";
    return `codex exec ${CODEX_HOOK_TRUST} --skip-git-repo-check${settings} resume ${id} "<prompt>"`;
  },
  cursor: (id) => `agent -p --resume ${id} "<prompt>"`,
  opencode: (id) => `opencode run --session ${id} "<prompt>"`,
};

const NATIVE_UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
// OpenCode session IDs are "ses_" and 26 base-62 characters (OpenCode 2.2.5 logs and API).
export const OPENCODE_SESSION_ID = /^ses_[A-Za-z0-9]{20,40}$/;
export const SANDBOX_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const pending = new Map<string, { action: string; promise: Promise<Outcome> }>();
// Asked of a running session that ai-collab cannot compact from outside; delivered urgent, at its next hook.
export const COMPACT_REQUEST = "[ai-collab] The operator asked to compact this session's context. Finish or checkpoint your current step, "
  + "reply to the operator in one line with what is still in progress, then end your turn so the operator can run /compact.";

export const SCOPE_ENV = "AI_COLLAB_SCOPE";
const UNIT_CHARS = /[^a-zA-Z0-9]/g;
const SCOPE_LABEL_MAX = 40;
const PROBE_TIMEOUT_MS = 5000;
// A failed probe is retried after this long, so a briefly busy manager does not disable scoping for good.
const PROBE_RETRY_MS = 60_000;
const probed = new Map<string, ScopeVerdict>();

export const START_HARNESSES = HARNESSES;
export const START_PLACES = ["folder", "worktree", "openshell"];
// Harnesses the runner can start in its own per-project OpenShell sandbox (runner/adapters/*.mjs capabilities.places).
export const RUNNER_SANDBOX_HARNESSES = ["cursor"];
const GIT_TIMEOUT_MS = 30_000;
export const PROMPT_MAX_CHARS = 4000;
const ID_WAIT_MS = 15_000;
const ID_POLL_MS = 200;
const LOG_READ_MAX = 64 * 1024;
const LOG_END_MAX = 256 * 1024;
const UUID_IN_TEXT = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

function registry(cfg: SessionCfg): string {
  return join(cfg.stateDir, cfg.project, "registry");
}

// Registry file of this config's own session.
function ownFile(cfg: SessionCfg): string {
  return join(registry(cfg), `${cfg.peer}#${cfg.session}.json`);
}

// The session's own registry entry, or {}.
function readOwn(cfg: SessionCfg): Partial<Session> {
  try { return JSON.parse(readFileSync(ownFile(cfg), "utf8")) || {}; } catch { return {}; }
}

/** The identity fields set_identity stores, validated: name, activity line, tags. */
function cleanIdentity({ name, activity, tags }: Identity): Identity {
  return {
    ...(typeof name === "string" && NAME.test(name) ? { name } : {}),
    ...(typeof activity === "string" && activity.trim() && activity.length <= ACTIVITY_MAX ? { activity: stripControl(activity).replace(/\s+/g, " ").trim() } : {}),
    ...(Array.isArray(tags) && tags.length && tags.length <= TAGS_MAX && tags.every((tag) => typeof tag === "string" && TAG.test(tag)) ? { tags } : {}),
  };
}

/** Records the session; operatorPromptAt (ms) marks a typed operator prompt and is kept across later writes. */
export async function recordSession(cfg: SessionCfg, { id, cwd, harness, event, proc, operatorPromptAt, parent, name, model, requireRunCode }: {
  id: string; cwd: string; harness: string; event: string; proc?: Proc; operatorPromptAt?: number; parent?: string; name?: string; model?: unknown; requireRunCode?: boolean;
}): Promise<void> {
  if (!cfg.session || cfg.session !== sessionLabel(id) || id.length > 256 || !isAbsolute(cwd)) return;
  const address = `${cfg.peer}#${cfg.session}`;
  const file = ownFile(cfg);
  await withLock(file, async () => {
    const last = operatorPromptAt || lastOperatorPromptAt(cfg);
    const own = readOwn(cfg);
    const { parentNotifiedAt } = own;
    // The harness's session name stays until the harness reports a new one.
    const title = name || (typeof own.name === "string" && !MACHINE_NAME.test(own.name) ? own.name : "");
    // The model a hook reports stays until a later hook reports another.
    const modelName = typeof model === "string" && MODEL.test(model) ? model : (typeof own.model === "string" ? own.model : "");
    writeState(file, {
      id: address, sessionId: id, cwd, harness, event, seenAt: Date.now(),
      ...(modelName ? { model: modelName } : {}),
      ...(requireRunCode === true || own.requireRunCode === true ? { requireRunCode: true } : {}),
      ...(proc ? { pid: proc.pid, pidStart: proc.start } : {}),
      ...(last ? { lastOperatorPromptAt: last } : {}),
      ...(parent ? { parent } : {}),
      ...(title ? { name: title } : {}),
      ...(Number.isSafeInteger(parentNotifiedAt) ? { parentNotifiedAt } : {}),
      ...cleanIdentity(own),
      // The set_identity name survives a hook that reports another title.
      ...(typeof own.identityName === "string" && NAME.test(own.identityName) ? { identityName: own.identityName } : {}),
    });
  });
  // An auto-joined repo records its root so the UI and phone starts find it (lib/config.mjs listProjects).
  if (cfg.auto && isAbsolute(cfg.root || "")) writeState(join(cfg.stateDir, "auto-projects", `${cfg.project}.json`), { root: cfg.root });
}

/**
 * Stores this session's name, activity line and tags in its registry entry, shown by list_agents.
 * A field left undefined keeps its value; "" or [] clears it. Throws until a hook has registered the session.
 */
export async function setIdentity(cfg: SessionCfg, { name, activity, tags }: { name?: string; activity?: string; tags?: string[] } = {}): Promise<Identity> {
  if (!cfg.session) throw new Error("Pass the session label supplied by the ai-collab hook");
  if (name !== undefined && name !== "" && !(typeof name === "string" && NAME.test(name))) throw new Error("name must be 1-40 letters, digits, spaces, or . _ -");
  if (activity !== undefined && (typeof activity !== "string" || activity.length > ACTIVITY_MAX)) throw new Error(`activity must be at most ${ACTIVITY_MAX} characters`);
  if (tags !== undefined && (!Array.isArray(tags) || tags.length > TAGS_MAX || !tags.every((tag) => typeof tag === "string" && TAG.test(tag)))) {
    throw new Error(`tags: at most ${TAGS_MAX}, each 1-40 characters of a-z, A-Z, 0-9 and : . / # _ -`);
  }
  const file = ownFile(cfg);
  const r = await withLock(file, async (): Promise<Identity> => {
    const own = readOwn(cfg);
    if (!own.id) throw new Error("This session is not registered yet; its first hook registers it");
    const next = { ...own, ...(name !== undefined ? { name, identityName: name } : {}), ...(activity !== undefined ? { activity } : {}), ...(tags !== undefined ? { tags } : {}) };
    const { name: _n, identityName: _i, activity: _a, tags: _t, ...rest } = next;
    const identity = cleanIdentity(next);
    // identityName is the set_identity name, kept apart from the harness title later hooks write over it.
    writeState(file, { ...rest, ...identity, ...(typeof next.identityName === "string" && NAME.test(next.identityName) ? { identityName: next.identityName } : {}) });
    return identity;
  });
  if (!r.locked) throw new Error("The session registry is busy; retry");
  return r.value as Identity;
}

/** Marks the parent as told about this session; true only the first time. */
export async function claimParentNotice(cfg: SessionCfg): Promise<boolean> {
  if (!cfg.session) return false;
  const file = ownFile(cfg);
  const r = await withLock(file, async () => {
    const own = readOwn(cfg);
    if (!own.id || own.parentNotifiedAt) return false;
    writeState(file, { ...own, parentNotifiedAt: Date.now() });
    return true;
  });
  return Boolean(r.locked && r.value);
}

/** When the operator last typed a prompt in this session (ms), or 0. */
export function lastOperatorPromptAt(cfg: SessionCfg): number {
  if (!cfg.session) return 0;
  const at = readOwn(cfg).lastOperatorPromptAt;
  return Number.isSafeInteger(at) && (at as number) > 0 ? (at as number) : 0;
}

/** Sessions on this machine for agents to find each other, newest activity first. Local only: includes cwd and the resume command. */
export function sessionDirectory(cfg: SessionCfg): Record<string, unknown>[] {
  return listSessions(cfg).sort((a, b) => (b.seenAt || 0) - (a.seenAt || 0)).map((s) => ({
    address: s.id, harness: s.harness, online: s.online, ...(s.runningJobs ? { runningJobs: s.runningJobs } : {}), lastActive: s.seenAt ? new Date(s.seenAt).toISOString() : "",
    ...(s.parent ? { parent: s.parent } : {}), cwd: s.cwd, ...(RESUME[s.harness] && /^[\w.-]{1,128}$/.test(s.sessionId) ? { resume: `${s.requireRunCode === true ? `${REQUIRE_RUN_CODE_ENV}=1 ` : ""}${RESUME[s.harness](s.sessionId, s.requireRunCode === true)}` } : {}),
  }));
}

/**
 * list_agents: this project's sessions with their set_identity fields, newest activity first; online ones only unless all.
 * tags keeps only sessions that carry every listed tag. Shows no cwd or resume command (list_sessions has those).
 */
export function agentDirectory(cfg: SessionCfg, { all = false, tags = [] }: { all?: boolean; tags?: string[] } = {}): Record<string, unknown>[] {
  const has = (s: Session) => tags.every((tag) => cleanIdentity(s).tags?.includes(tag));
  return listSessions(cfg).filter((s) => (all || s.online || s.runningJobs) && has(s)).sort((a, b) => (b.seenAt || 0) - (a.seenAt || 0)).map((s) => ({
    address: s.id, harness: s.harness, project: cfg.project, ...cleanIdentity(s), online: s.online, ...(s.runningJobs ? { runningJobs: s.runningJobs } : {}),
    ...(typeof s.identityName === "string" && NAME.test(s.identityName) ? { identityName: s.identityName } : {}),
    lastActive: s.seenAt ? new Date(s.seenAt).toISOString() : "", ...(s.parent ? { parent: s.parent } : {}),
  }));
}

export function listSessions(cfg: SessionCfg): Session[] {
  let files: string[];
  try { files = readdirSync(registry(cfg)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return files.filter(file => REGISTRY_FILE.test(file)).flatMap(file => {
    try {
      const session = JSON.parse(readFileSync(join(registry(cfg), file), "utf8")) as Session;
      const [peer, label] = session.id.split("#");
      if (file !== session.id + ".json" || sessionLabel(session.sessionId) !== label ||
          (cfg.peers.length && !cfg.peers.includes(peer))) return [];
      const jobs = runningJobs(registry(cfg), session.id, files);
      return [{
        ...session, peer, session: label,
        ...(jobs ? { runningJobs: jobs } : {}),
        online: isRunning({ pid: session.pid as number, start: session.pidStart as string }),
      }];
    } catch {
      return [];
    }
  });
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/** Deletes an offline session's registry file; throws status 400/404/409 for a bad address, an unknown session, or a running one. */
export function disposeSession(cfg: SessionCfg, address: unknown): void {
  if (typeof address !== "string" || !ADDRESS.test(address)) throw httpError(400, "Invalid session address");
  const session = listSessions(cfg).find(item => item.id === address);
  if (!session) throw httpError(404, "Unknown session");
  if (session.online || session.runningJobs) throw httpError(409, "The session is running");
  rmSync(join(registry(cfg), `${address}.json`), { force: true });
}

// The worktrees directory of a project root, with its trailing separator.
function worktreesDir(root: string): string {
  return root ? join(root, ".claude", "worktrees") + sep : "";
}

/**
 * The worktree folder a cwd belongs to, or "": the first folder under a worktrees directory, so a session started in
 * one of its subfolders still names (and checks) the worktree itself.
 */
export function worktreeRoot(cwd: unknown, root = ""): string {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return "";
  const trees = worktreesDir(root);
  if (trees && cwd.startsWith(trees)) return trees + cwd.slice(trees.length).split(sep)[0];
  const match = cwd.match(/^(.*\/\.?(?:claude\/)?worktrees\/[^/]+)/);
  return match ? match[1] : "";
}

/** An offline session whose worktree was deleted: nothing can resume there, so the session cards leave it out. */
export function worktreeGone({ cwd, online, sandbox }: { cwd: string; online?: boolean; sandbox?: boolean }, root = ""): boolean {
  if (online || sandbox) return false;
  const tree = worktreeRoot(cwd, root);
  if (!tree) return false;
  try { return !statSync(tree).isDirectory(); } catch { return true; }
}

/** Where a session runs: "sandbox", "folder" (the project root), "worktree <name>", else the cwd with ~ for home; "" without a cwd. */
export function sessionPlace({ cwd, sandbox }: { cwd?: unknown; sandbox?: boolean }, root = ""): string {
  if (sandbox) return "sandbox";
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return "";
  if (root && cwd === root) return "folder";
  const trees = worktreesDir(root);
  if (trees && cwd.startsWith(trees)) return "worktree " + cwd.slice(trees.length).split(sep)[0];
  if (/\/\.?(claude\/)?worktrees\/[^/]+\/?$/.test(cwd)) return "worktree " + basename(cwd);
  const home = homedir();
  return cwd === home || cwd.startsWith(home + sep) ? "~" + cwd.slice(home.length) : cwd;
}

export function ownedDir(cfg: SessionCfg): string {
  return join(cfg.stateDir, cfg.project, "owned");
}

export function ownedFile(cfg: SessionCfg, label: string): string {
  if (!SESSION_LABEL.test(label || "")) throw new Error("invalid session label");
  return join(ownedDir(cfg), `${label}.json`);
}

/** The owned record for a session label, or null when absent or unreadable. */
export function readOwned(cfg: SessionCfg, label: string | undefined): OwnedRecord | null {
  if (!SESSION_LABEL.test(label || "")) return null;
  try {
    const record = JSON.parse(readFileSync(ownedFile(cfg, label as string), "utf8"));
    return record && record.v === 1 && record.label === label ? record : null;
  } catch {
    return null;
  }
}

/** Writes the record atomically (0600 file in a 0700 dir). */
export function writeOwned(cfg: SessionCfg, record: { label: string; [field: string]: unknown }): void {
  writeState(ownedFile(cfg, record.label), { ...record, v: 1, updatedAt: Date.now() });
}

/** Every readable owned record of this project. */
export function listOwned(cfg: SessionCfg): OwnedRecord[] {
  let files: string[];
  try { files = readdirSync(ownedDir(cfg)); } catch { return []; }
  return files.filter((file) => OWNED_LABEL_FILE.test(file)).map((file) => readOwned(cfg, file.slice(0, -5))).filter((r): r is OwnedRecord => Boolean(r));
}

/**
 * True when the label has an owned record that has not ended, so only the process the runner spawned stands down.
 * An agent started inside it has its own native session id and no record; it registers as the owned session's child (lib/family.mjs).
 */
export function standsDown(cfg: SessionCfg | undefined, { label }: { label: string }): boolean {
  if (!cfg?.stateDir || !cfg.project || !SESSION_LABEL.test(label || "")) return false;
  if (!existsSync(join(ownedDir(cfg), `${label}.json`))) return false;
  const record = readOwned(cfg, label);
  return Boolean(record && record.status !== "ended");
}

// Last bytes of a file as text; "" when unreadable.
function tail(file: string, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A clean one-line name of at most NAME_MAX characters, or "". */
export function cleanName(value: unknown): string {
  if (typeof value !== "string") return "";
  return stripControl(value).replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
}

/** The harness's own name for this session, or "". */
export function sessionName(host: string, msg: { agent_id?: unknown; session_title?: unknown; session_id?: unknown } = {}, env: NodeJS.ProcessEnv = process.env): string {
  // Hooks inside a subagent carry the parent's session id; their title would rename the parent.
  if (typeof msg.agent_id === "string" && msg.agent_id) return "";
  if (host === "claude" || host === "opencode") {
    const name = cleanName(msg.session_title);
    return MACHINE_NAME.test(name) ? "" : name;
  }
  if (host !== "codex" || typeof msg.session_id !== "string" || !msg.session_id) return "";
  const index = join(env.CODEX_HOME || join(env.HOME || homedir(), ".codex"), "session_index.jsonl");
  const lines = tail(index, INDEX_TAIL_BYTES).split("\n").reverse();
  for (const line of lines) {
    if (!line.includes(msg.session_id)) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.id === msg.session_id) return cleanName(entry.thread_name);
    } catch { /* partial first line */ }
  }
  return "";
}

// The UTC time as a compact stamp: 20260325T101500Z.
function utcStamp(at: number): string {
  return new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** First executable named systemd-run on a PATH value, or "". */
export function systemdRunOnPath(path = ""): string {
  return findExecutable("systemd-run", path);
}

/** A transient unit name: ai-collab-<kind>-<label>-<UTC stamp>-<random>, legal for systemd and unique per start. */
export function scopeUnitName(kind: string, at: number, label = "", random: () => string = () => randomBytes(3).toString("hex")): string {
  const slug = String(label).toLowerCase().replace(UNIT_CHARS, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, SCOPE_LABEL_MAX);
  return ["ai-collab", kind, slug, utcStamp(at), random()].filter(Boolean).join("-");
}

/**
 * Whether trying a scope is right here: systemd-run is installed, this process is a systemd unit with a cgroup to
 * leave, and a user manager socket is there. Returns {ok, why}; why names the reason in either case.
 */
export function scopeSupport({ env = process.env, systemdRun = "" }: { env?: NodeJS.ProcessEnv; systemdRun?: string } = {}): ScopeVerdict {
  const mode = env[SCOPE_ENV] || "";
  if (mode && mode !== "on" && mode !== "off") return { ok: false, why: `${SCOPE_ENV} must be on or off` };
  if (mode === "off") return { ok: false, why: `${SCOPE_ENV}=off` };
  if (!systemdRun) return { ok: false, why: "systemd-run is not installed" };
  if (!env.DBUS_SESSION_BUS_ADDRESS && !(env.XDG_RUNTIME_DIR && existsSync(join(env.XDG_RUNTIME_DIR, "bus")))) {
    return { ok: false, why: "no systemd user manager" };
  }
  if (mode !== "on" && !env.INVOCATION_ID) return { ok: false, why: "not started by systemd, so no cgroup to leave" };
  return { ok: true, why: "systemd-run --user --scope" };
}

// Runs one throwaway scoped command, so a systemd-run that cannot reach its manager also falls back.
function liveProbe(systemdRun: string, env: NodeJS.ProcessEnv): ScopeVerdict {
  try {
    // node with an empty program: always present, quick, and proves the manager can start a process in a scope.
    execFileSync(systemdRun, ["--user", "--scope", "--quiet", "--collect", `--unit=${scopeUnitName("probe", Date.now())}`, "--", process.execPath, "-e", ""],
      { env, stdio: ["ignore", "ignore", "pipe"], timeout: PROBE_TIMEOUT_MS });
    return { ok: true, why: "systemd-run --user --scope" };
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    const line = String(stderr || (error as Error).message).trim().split("\n")[0] || "no output";
    return { ok: false, why: `systemd-run cannot make a scope: ${line}` };
  }
}

/** scopeSupport plus one cached live probe of this systemd-run: the verdict a launch may rely on. */
export function scopeAvailable({ env = process.env, systemdRun = systemdRunOnPath(env.PATH), now = Date.now }: { env?: NodeJS.ProcessEnv; systemdRun?: string; now?: () => number } = {}): ScopeVerdict {
  const support = scopeSupport({ env, systemdRun });
  if (!support.ok) return support;
  const cached = probed.get(systemdRun);
  // A pass is kept for the process's life; a failure is retried later.
  if (cached && (cached.ok || now() - (cached.at as number) < PROBE_RETRY_MS)) return cached;
  const verdict = { ...liveProbe(systemdRun, env), at: now() };
  probed.set(systemdRun, verdict);
  return verdict;
}

/** Forgets the cached probes, so a test may change what systemd-run does mid-run. */
export function resetScopeProbe(): void {
  probed.clear();
}

/**
 * The argv that runs [file, ...args] in a transient scope. `--` separates the command, so a harness flag is never read
 * as a systemd-run option; RuntimeMaxSec holds the payload to its deadline even if the caller dies.
 */
export function scopeWrap([file, ...args]: string[], { systemdRun, unit, cwd = "", description = "", runtimeMaxSec }: {
  systemdRun: string; unit: string; cwd?: string; description?: string; runtimeMaxSec?: number;
}): Command {
  return [systemdRun, [
    "--user", "--scope", "--quiet", "--collect", `--unit=${unit}`,
    ...(description ? [`--description=${description}`] : []),
    ...(runtimeMaxSec ? [`--property=RuntimeMaxSec=${Math.max(1, Math.ceil(runtimeMaxSec))}`] : []),
    ...(cwd ? [`--working-directory=${cwd}`] : []),
    "--", file, ...args,
  ]];
}

/**
 * The command to spawn for one unit of work: [file, ...args] wrapped in a scope when this host can make one, else as
 * given. Returns {file, args, scoped, unit, why}, why naming the reason either way.
 */
export function scopeLaunch([file, ...args]: string[], { env = process.env, path = env.PATH || "", kind = "session", label = "", at = Date.now(), cwd = "", description = "", runtimeMaxSec }: {
  env?: NodeJS.ProcessEnv; path?: string; kind?: string; label?: string; at?: number; cwd?: string; description?: string; runtimeMaxSec?: number;
} = {}): LaunchStart {
  const systemdRun = systemdRunOnPath(path);
  const available = scopeAvailable({ env, systemdRun });
  if (!available.ok) return { file, args, scoped: false, unit: "", why: available.why };
  const unit = scopeUnitName(kind, at, label);
  const wrapped = scopeWrap([file, ...args], { systemdRun, unit, cwd, description, runtimeMaxSec });
  return { file: wrapped[0], args: wrapped[1], scoped: true, unit, why: available.why };
}

/** The binary and argv that act on a session; the Cursor name is cursorBinary on the PATH the wake runs with. */
export function harnessCommand(action: string, harness: string, id: string, requireRunCode: boolean, { path = "" }: { path?: string } = {}): Command | null {
  if (action === "wake") return argv(harness as Harness, "wake", { id, prompt: WAKE_PROMPT, requireRunCode, path });
  if (action === "compact") return argv(harness as Harness, "compact", { id });
  return null;
}

/** Whether a session ID has the shape its harness uses. */
export function nativeSessionId(harness: string, id: unknown): boolean {
  return typeof id === "string" && (harness === "opencode" ? OPENCODE_SESSION_ID : NATIVE_UUID).test(id);
}

/** The environment for a harness child: this process's without AI_COLLAB_*, with node's and ~/.local/bin on PATH. */
export function harnessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AI_COLLAB_")));
  env.PATH = [dirname(process.execPath), join(homedir(), ".local", "bin"), env.PATH].filter(Boolean).join(delimiter);
  return env;
}

/** Runner from AI_COLLAB_WAKE_RUNNER (host | openshell) and AI_COLLAB_OPENSHELL_SANDBOX. */
export function runnerFromEnv(env: NodeJS.ProcessEnv = process.env): { kind: string; sandbox?: string } {
  const kind = env.AI_COLLAB_WAKE_RUNNER || "host";
  if (kind === "host") return { kind };
  if (kind === "openshell" && SANDBOX_NAME.test(env.AI_COLLAB_OPENSHELL_SANDBOX || "")) {
    return { kind, sandbox: env.AI_COLLAB_OPENSHELL_SANDBOX };
  }
  return { kind: "invalid" };
}

/** The argv as given on the host, or wrapped in `openshell sandbox exec` for the openshell runner. */
export function placeCommand([file, args]: Command, cwd: string, runner: { kind: string; sandbox?: string }): Command {
  if (runner.kind !== "openshell") return [file, args];
  return ["openshell", ["sandbox", "exec", "--name", runner.sandbox as string, "--workdir", cwd, "--no-tty", "--no-login-shell", "--", file, ...args]];
}

function invoke(file: string, args: string[], options: SpawnOptions): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, stdio: "ignore", shell: false });
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
}

/** Compact a saved Claude session through the Agent SDK; resolves with its compact_boundary metadata. */
async function sdkCompact(sessionId: string, cwd: string): Promise<{ boundary: { pre_tokens: number; post_tokens: number } | null; result: string | null }> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  let boundary: { pre_tokens: number; post_tokens: number } | null = null;
  let result: string | null = null;
  for await (const m of query({ prompt: "/compact", options: { cwd, resume: sessionId, settingSources: [], allowedTools: [] } })) {
    if (m.type === "system" && m.subtype === "compact_boundary") boundary = m.compact_metadata as { pre_tokens: number; post_tokens: number };
    if (m.type === "result") result = m.subtype;
  }
  return { boundary, result };
}

/**
 * Compaction of a running session. Codex: compact over the local app-server daemon when the thread is loaded there and
 * idle. Otherwise (Claude, Cursor, a busy or unattached Codex thread) send an urgent operator message asking the session to finish its step.
 */
async function compactRunning(peer: Session, { cfg, codexLive, runner, env }: {
  cfg?: SessionCfg; codexLive: CodexLive; runner: { kind: string; sandbox?: string }; env: NodeJS.ProcessEnv;
}): Promise<Outcome> {
  const { sessionId, cwd, harness } = peer;
  let note = "";
  if (harness === "codex") {
    try {
      const r = await codexLive(sessionId, { cwd, env, command: placeCommand(["codex", ["app-server", "proxy"]], cwd, runner) });
      if (r.status === "compacted") return { status: "succeeded", detail: "Codex compacted the running thread through its app-server daemon." };
      note = r.status === "busy" ? "Codex is mid-turn. " : "This Codex session is not attached to the app-server daemon. ";
    } catch {
      note = "The Codex app-server daemon did not compact the thread. ";
    }
  }
  if (!cfg?.enabled) return { status: "unsupported", detail: `${note}The session is running. Run /compact in it directly.` };
  const where = harness === "claude" ? " in its terminal or from Remote Control" : harness === "codex" ? " in it, or press Compact again once its turn ends" : " in it";
  try {
    await sendMessage({ ...cfg, peer: "operator", session: "" } as never, peer.id as string, COMPACT_REQUEST, { operatorThread: true, system: true, urgent: true } as never);
  } catch {
    return { status: "failed", detail: `${note}The compaction request could not be sent. Run /compact${where}.` };
  }
  return { status: "requested", detail: `${note}Asked the session to finish its step at its next hook. Run /compact${where}.` };
}

async function run(action: string, peer: Session, { execute = invoke, compact = sdkCompact, codex = codexCompact, codexLive = codexLiveCompact, runner = runnerFromEnv(), cfg }: {
  execute?: (file: string, args: string[], options: SpawnOptions) => Promise<number | null>;
  compact?: typeof sdkCompact;
  codex?: CodexCall;
  codexLive?: CodexLive;
  runner?: { kind: string; sandbox?: string };
  cfg?: SessionCfg;
} = {}): Promise<Outcome> {
  const { sessionId, cwd, harness } = peer;
  if (!nativeSessionId(harness, sessionId) || typeof cwd !== "string" || !isAbsolute(cwd) ||
      !peer.id?.endsWith("#" + sessionLabel(sessionId))) {
    return { status: "unsupported", detail: "Missing a verified native session ID or workspace." };
  }
  const env = harnessEnv();
  const command = harnessCommand(action, harness, sessionId, peer.requireRunCode === true, { path: env.PATH });
  const sdk = action === "compact" && harness === "claude";
  const appServer = action === "compact" && harness === "codex";
  const adapter = Boolean(command || sdk || appServer);
  const noAdapter = { status: "unsupported", detail: `No ${action} adapter for ${harness}.` };
  // A running Cursor session still gets the compaction request; an exited one has no adapter.
  if (!adapter && !(action === "compact" && ["claude", "codex", "cursor"].includes(harness))) return noAdapter;
  if (runner.kind === "invalid") return { status: "failed", detail: "AI_COLLAB_WAKE_RUNNER is misconfigured." };
  if (!Number.isInteger(peer.pid) || typeof peer.pidStart !== "string") {
    return { status: "unsupported", detail: "No recorded harness process, so exit cannot be verified. The message stays queued." };
  }
  // OpenCode compacts through its server whether or not a turn is running.
  const serverCompact = action === "compact" && harness === "opencode";
  if (!serverCompact && isRunning({ pid: peer.pid as number, start: peer.pidStart })) {
    return action === "wake"
      ? { status: "queued", detail: "The session is running. Its next hook delivers the message." }
      : compactRunning(peer, { cfg, codexLive, runner, env });
  }
  if (!adapter) return noAdapter;
  if (sdk) {
    try {
      const { boundary, result } = await compact(sessionId as string, cwd);
      if (!boundary) return { status: "failed", detail: `Claude finished (${result ?? "no result"}) without compacting.` };
      return { status: "succeeded", detail: `Compacted ${boundary.pre_tokens} → ${boundary.post_tokens} tokens.` };
    } catch {
      return { status: "failed", detail: "Claude Agent SDK compaction failed." };
    }
  }
  if (appServer) {
    try {
      await codex(sessionId as string, { cwd, env, command: placeCommand(["codex", ["app-server"]], cwd, runner) });
      return { status: "succeeded", detail: "Codex compacted the thread." };
    } catch {
      return { status: "failed", detail: "Codex app-server compaction failed." };
    }
  }
  const [file, args] = placeCommand(command as Command, cwd, runner);
  if (action === "wake" && peer.requireRunCode === true) env[REQUIRE_RUN_CODE_ENV] = "1";
  env[WAKE_ENV] = "1"; // hooks in the resumed run must not read its prompt as the operator returning
  try {
    const code = await execute(file, args, { cwd, env });
    if (code !== 0) return { status: "failed", detail: file + " exited " + (code ?? "after a signal") + "." };
    return { status: "succeeded", detail: serverCompact ? "OpenCode compacted the session." : "The harness finished the resumed turn." };
  } catch (error) {
    return { status: "failed", detail: (error as NodeJS.ErrnoException).code === "ENOENT" ? "Executable or workspace unavailable." : "Harness invocation failed." };
  }
}

/** One control run per session at a time; concurrent retries share the in-flight result. */
export function controlSession(action: string, peer: Session | undefined, options?: Parameters<typeof run>[2]): Promise<Outcome> {
  if (!peer) return Promise.resolve({ status: "unsupported", detail: "Missing local session registration." });
  const key = JSON.stringify([peer.harness, peer.sessionId]);
  const active = pending.get(key);
  if (active?.action === action) return active.promise;
  if (active) return Promise.resolve({ status: "failed", detail: `A ${active.action} run for this session is in progress. Retry after it finishes.` });
  const promise = run(action, peer, options).finally(() => pending.delete(key));
  pending.set(key, { action, promise });
  return promise;
}

/**
 * Interrupts the in-progress turn of a thread loaded in the app-server daemon.
 * Resolves {status:"interrupted"}, {status:"not-running"} (no turn in progress) or {status:"not-loaded"}.
 */
export async function codexLiveInterrupt(threadId: string, { cwd, env, command = argv("codex", "interrupt", {}) as Command, timeoutMs = 15_000 }: {
  cwd?: string; env?: NodeJS.ProcessEnv; command?: Command; timeoutMs?: number;
} = {}): Promise<{ status: string }> {
  const rpc = connect(command, { cwd, env });
  const timer = setTimeout(() => rpc.close(), timeoutMs);
  try {
    await rpc.request("initialize", { clientInfo: CLIENT, capabilities: null });
    rpc.send({ method: "initialized" });
    const loaded: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await rpc.request("thread/loaded/list", cursor ? { cursor } : {}) as { data?: string[]; nextCursor?: unknown };
      loaded.push(...(Array.isArray(page?.data) ? page.data : []));
      cursor = typeof page?.nextCursor === "string" ? page.nextCursor : null;
    } while (cursor && !loaded.includes(threadId));
    if (!loaded.includes(threadId)) return { status: "not-loaded" };
    const read = await rpc.request("thread/read", { threadId, includeTurns: true }) as { thread?: { turns?: { id?: string; status?: string }[] } };
    const turn = (read?.thread?.turns ?? []).findLast((t) => t?.status === "inProgress");
    if (!turn?.id) return { status: "not-running" };
    await rpc.request("turn/interrupt", { threadId, turnId: turn.id });
    return { status: "interrupted" };
  } finally {
    clearTimeout(timer);
    rpc.close();
  }
}

/** Interrupts a registry session's running turn; resolves {status: succeeded|not-running|unsupported|failed, detail}. */
export async function interruptSession(peer: Session | null | undefined, { env = harnessEnv(), runner = runnerFromEnv(), codexInterrupt = codexLiveInterrupt, opencode = opencodeRequest }: {
  env?: NodeJS.ProcessEnv;
  runner?: { kind: string; sandbox?: string };
  codexInterrupt?: typeof codexLiveInterrupt;
  opencode?: typeof opencodeRequest;
} = {}): Promise<Outcome> {
  if (!peer) return { status: "unsupported", detail: "Missing local session registration." };
  const { sessionId, cwd, harness } = peer;
  if (!["codex", "opencode"].includes(harness)) {
    return { status: "unsupported", detail: `${harness} has no outside interrupt; press Esc in its terminal.` };
  }
  if (!nativeSessionId(harness, sessionId) || !peer.id?.endsWith("#" + sessionLabel(sessionId))) {
    return { status: "unsupported", detail: "Missing a verified native session ID." };
  }
  if (harness === "opencode") {
    const r = await opencode("POST", `/api/session/${encodeURIComponent(sessionId as string)}/interrupt`);
    if (!r.ok) return r.status === 404 ? { status: "not-running", detail: "OpenCode has no such running session." } : { status: "failed", detail: r.error as string };
    const interrupted = r.body?.interrupted ?? r.body?.data?.interrupted;
    return interrupted ? { status: "succeeded", detail: "OpenCode interrupted the turn." } : { status: "not-running", detail: "No turn was running." };
  }
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return { status: "unsupported", detail: "Missing a workspace." };
  if (runner.kind === "invalid") return { status: "failed", detail: "AI_COLLAB_WAKE_RUNNER is misconfigured." };
  try {
    const r = await codexInterrupt(sessionId as string, { cwd, env, command: placeCommand(argv("codex", "interrupt", {}) as Command, cwd, runner) });
    if (r.status === "interrupted") return { status: "succeeded", detail: "Codex interrupted the turn." };
    if (r.status === "not-running") return { status: "not-running", detail: "No turn was running." };
    return { status: "unsupported", detail: "This Codex session is not attached to the app-server daemon." };
  } catch {
    return { status: "failed", detail: "The Codex app-server daemon did not interrupt the turn." };
  }
}

/** Why a start is refused before spawning: an unknown harness, a mode it lacks, or a model it cannot pass; "" when fine. */
export function startRefusal(harness: string, mode = "agent", model?: unknown): string {
  if (!LAUNCH_BINARY[harness as Harness]) return "Unknown harness";
  if (!modeFlags(harness, mode)) return `Unknown ${harness} mode`;
  if (model !== undefined && !modelShape(harness, model)) return "Unknown harness or model";
  return "";
}

/**
 * Fixed argv per harness: [file, args]; worktree names Claude's own --worktree; model must pass modelShape.
 * The mode comes from the new-agent dialogue's Agent / Ask / Plan pill: its flags are the harness's own read-only
 * switches (web/lib/start-mode.js), so "agent" adds nothing and a mode the harness lacks returns null.
 */
export function startCommand(harness: string, root: string, prompt: string, { worktree = "", model, mode, codeMode, requireRunCode = false }: {
  worktree?: string; model?: string; mode?: string; codeMode?: boolean; requireRunCode?: boolean;
} = {}): Command | null {
  return argv(harness as Harness, "start", { root, prompt, worktree, model, mode, codeMode, requireRunCode } as never);
}

/** Maps a startCommand's cursor binary onto this machine's name: `agent` when installed, else `cursor-agent`. */
export function resolveStartBinary(harness: string, cmd: Command | null, path = ""): Command | null {
  if (!cmd) return cmd;
  if (harness !== "cursor") return cmd;
  return [cursorCommandFor({ path }), cmd[1]];
}

/** The child's environment: no AI_COLLAB_* settings, the usual install dirs on PATH, and marked as not the operator typing. */
export function childEnv(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("AI_COLLAB_")));
  // The caller's PATH wins; the install dirs only fill in for a service started with a bare PATH.
  out.PATH = childPath(env, execPath);
  out[WAKE_ENV] = "1"; // the phone prompt is not the operator at a terminal, so it must not turn AFK off
  return out;
}

/** Absolute path of an executable on PATH, or "". */
export function findExecutable(name: string, path = ""): string {
  for (const dir of path.split(delimiter).filter((d) => isAbsolute(d))) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch { /* next */ }
  }
  return "";
}

/** Harnesses this project may start: configured as a peer (or no peer list) and installed. */
export function availableHarnesses(cfg: SessionCfg, env: NodeJS.ProcessEnv = process.env): Harness[] {
  const { PATH } = childEnv(env);
  return START_HARNESSES.filter((h) => (!cfg.peers.length || cfg.peers.includes(h))
    && (h === "cursor" ? CURSOR_BINARIES.some((name) => findExecutable(name, PATH as string)) : findExecutable(LAUNCH_BINARY[h], PATH as string)));
}

/** The sandbox from AI_COLLAB_OPENSHELL_SANDBOX, the runner wake uses, or null. */
export function openshellRunner(env: NodeJS.ProcessEnv = process.env): { kind: string; sandbox: string } | null {
  const sandbox = env.AI_COLLAB_OPENSHELL_SANDBOX || "";
  return SANDBOX_NAME.test(sandbox) ? { kind: "openshell", sandbox } : null;
}

/** Whether the runner can take an OpenShell start: openshell installed and the runner's control socket present. */
export function runnerSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(findExecutable("openshell", childEnv(env).PATH as string) && existsSync(runnerSocket(env)));
}

/** Harnesses an openshell start may name: any, in the AI_COLLAB_OPENSHELL_SANDBOX sandbox; else the runner's sandbox harnesses. */
export function openshellHarnesses(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return openshellRunner(env) ? START_HARNESSES : RUNNER_SANDBOX_HARNESSES;
}

/** The registered root folder of a project name; throws when it is not in projects.json or is not a directory. */
export function projectRoot(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const entry = listProjects(env).find((p) => p.project === name);
  if (!entry) throw Object.assign(new Error("Project is not registered in projects.json"), { status: 400 });
  try {
    if (statSync(entry.root).isDirectory()) return entry.root;
  } catch { /* missing */ }
  throw Object.assign(new Error("The project folder is unavailable"), { status: 400 });
}

/** Where this project can start a session: its folder, a new git worktree (git repo and git installed), an openshell sandbox. */
export function availablePlaces(cfg: SessionCfg, env: NodeJS.ProcessEnv = process.env): string[] {
  const { PATH } = childEnv(env);
  const places = ["folder"];
  let root = "";
  try { root = projectRoot(cfg.project, env); } catch { return places; }
  if (existsSync(join(root, ".git")) && findExecutable("git", PATH as string)) places.push("worktree");
  if ((openshellRunner(env) && findExecutable("openshell", PATH as string)) || (existsSync(join(root, ".git")) && runnerSandbox(env))) places.push("openshell");
  return places;
}

/** The place a start gets when it names none: defaults.json startPlace when offered and this harness can run there, else folder. */
export function defaultStartPlace(places: string[], harness: string, env: NodeJS.ProcessEnv = process.env): string {
  const preferred = startPlaceSetting(env);
  if (!places.includes(preferred)) return "folder";
  if (preferred === "openshell" && !openshellHarnesses(env).includes(harness)) return "folder";
  return preferred;
}

// Worktree name and branch for one start: ai-collab-<harness>-<UTC stamp> on branch ai-collab/<harness>-<stamp>.
export function worktreeNames(harness: string, at: number): { name: string; branch: string } {
  const stamp = utcStamp(at);
  return { name: `ai-collab-${harness}-${stamp}`, branch: `ai-collab/${harness}-${stamp}` };
}

// Runs git with a fixed argv and no shell; resolves its exit code.
function runGit(file: string, args: string[], options: SpawnOptions): Promise<number> {
  return new Promise((resolve) => {
    execFile(file, args, { ...options, shell: false, timeout: GIT_TIMEOUT_MS }, (error) => resolve(error ? ((error as NodeJS.ErrnoException).code as unknown as number) ?? 1 : 0));
  });
}

/**
 * The folder a start runs in: the project root, or the origin folder (a session's worktree) when it lies inside the root
 * and still exists. Returns {cwd} or {error}; a missing origin is refused, not replaced by the root.
 */
export function startFolder(root: string, origin = ""): { cwd: string; error?: undefined } | { error: string; cwd?: undefined } {
  if (!origin) return { cwd: root };
  const folder = resolve(origin);
  if (folder !== root && !folder.startsWith(root + sep)) return { error: `The original folder is outside the project: ${folder}` };
  try {
    if (statSync(folder).isDirectory()) return { cwd: folder };
  } catch { /* gone */ }
  return { error: `The original folder is gone: ${folder}; start the session by hand` };
}

/** The prompt trimmed, or an error message: 1-4000 characters, no NUL, and no leading "-" that a CLI could read as a flag. */
export function checkPrompt(prompt: unknown): { text: string; error?: undefined } | { error: string; text?: undefined } {
  if (typeof prompt !== "string" || !prompt.trim() || prompt.trim().length > PROMPT_MAX_CHARS) return { error: "Enter a first prompt of 1–4000 characters" };
  const text = prompt.trim();
  if (text.includes("\0")) return { error: "The prompt contains a NUL character" };
  if (text.startsWith("-")) return { error: "The prompt cannot start with \"-\"" };
  return { text };
}

/** Session or thread id in a harness's first output; "" when none is printed yet. */
export function outputId(harness: string, text: string): string {
  for (const line of text.split("\n")) {
    if (harness === "claude") {
      const id = UUID_IN_TEXT.exec(line)?.[0];
      if (id) return id;
      continue;
    }
    let event: Record<string, unknown> | undefined;
    try { event = JSON.parse(line); } catch { continue; }
    const id = harness === "codex" ? event?.thread_id : harness === "opencode" ? event?.sessionID : event?.session_id;
    if (typeof id === "string" && id && id.length <= 128) return id;
  }
  return "";
}

// The whole log of a short session; "" past the cap, since a long session is not on its first turn.
function readWhole(file: string): string {
  try {
    return statSync(file).size <= LOG_END_MAX ? readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
}

function readHead(file: string): string {
  try {
    const fd = openSync(file, "r");
    try {
      const data = Buffer.alloc(LOG_READ_MAX);
      return data.subarray(0, readSync(fd, data)).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/**
 * Spawns the harness detached in the project root with its output in a log file under the state dir, then waits up to
 * waitMs for the session id it prints. Resolves {status:"started"|"failed", detail, session?, log}.
 * onEnd({code, signal, log}) runs when the process exits, with the log text of a short session.
 */
export async function startSession(cfg: SessionCfg, { harness, prompt, model, mode = "agent", place = "folder", origin = "", codeMode, requireRunCode = false, system = false, env = process.env, run: spawnChild = spawn, git = runGit, now = Date.now, waitMs = ID_WAIT_MS, onEnd }: {
  harness: string; prompt: string; model?: string; mode?: string; place?: string; origin?: string; codeMode?: unknown; requireRunCode?: boolean; system?: boolean;
  env?: NodeJS.ProcessEnv; run?: typeof spawn; git?: typeof runGit; now?: () => number; waitMs?: number;
  onEnd?: (end: { code: number | null; signal: string | null; log: string }) => unknown;
}): Promise<{ status: string; detail: string; log?: string; session?: string }> {
  if (isProjectPaused(cfg)) return { status: "failed", detail: PROJECT_PAUSED };
  const root = projectRoot(cfg.project, env);
  if (!START_PLACES.includes(place)) return { status: "failed", detail: "Unknown start place" };
  const refused = startRefusal(harness, mode, model);
  if (refused) return { status: "failed", detail: refused };
  const childVars = childEnv(env);
  if (system) childVars[SYSTEM_PROMPT_ENV] = "1";
  if (requireRunCode) childVars[REQUIRE_RUN_CODE_ENV] = "1";
  const tree = place === "worktree" ? worktreeNames(harness, now()) : null;
  const folder = startFolder(root, origin);
  if (folder.error) return { status: "failed", detail: folder.error };
  let cwd = folder.cwd as string;
  // Claude makes its own worktree (--worktree); other harnesses start in one git creates under .claude/worktrees/.
  if (tree && harness !== "claude" && START_HARNESSES.includes(harness as Harness)) {
    const gitFile = findExecutable("git", childVars.PATH as string);
    if (!gitFile) return { status: "failed", detail: "git is not installed" };
    cwd = join(root, ".claude", "worktrees", tree.name);
    const code = await git(gitFile, ["-C", root, "worktree", "add", "-b", tree.branch, cwd], { cwd: root, env: childVars });
    if (code !== 0) return { status: "failed", detail: `git worktree add exited ${code}` };
  }
  const base = startCommand(harness, cwd, prompt, { worktree: tree && harness === "claude" ? tree.name : "", model, mode, requireRunCode, codeMode: resolveCodeMode(codeMode as never, env) });
  if (!base) return { status: "failed", detail: startRefusal(harness, mode, model) || "Unknown harness" };
  const sandbox = place === "openshell" ? openshellRunner(env) : null;
  if (place === "openshell" && !sandbox) return { status: "failed", detail: "AI_COLLAB_OPENSHELL_SANDBOX is not set" };
  const cmd = resolveStartBinary(harness, base, childVars.PATH);
  const refusal = hostAgentRefusal(cmd as Command, { sandboxed: Boolean(sandbox), env });
  if (refusal) return { status: "failed", detail: refusal };
  const command = sandbox ? placeCommand(cmd as Command, cwd, sandbox) : cmd as Command;
  const file = findExecutable(command[0], childVars.PATH as string);
  if (!file) return { status: "failed", detail: `${command[0]} is not installed` };
  const dir = join(cfg.stateDir, cfg.project, "starts");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = join(dir, `${new Date(now()).toISOString().replace(/[:.]/g, "-")}-${harness}.log`);
  // A scope keeps the session alive across a UI or runner restart; the harness still gets the log file as its stdio.
  const launch = scopeLaunch([file, ...command[1]], {
    env, path: childVars.PATH, kind: "session", label: harness, description: `AI Collab ${harness} session`,
  });
  const fd = openSync(log, "a", 0o600);
  let child: ChildProcess;
  try {
    child = spawnChild(launch.file, launch.args, { cwd, env: childVars, detached: true, shell: false, stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd);
  }
  const where = tree ? `${basename(root)}, worktree ${tree.name}` : sandbox ? `${basename(root)}, openshell ${sandbox.sandbox}` : basename(root);
  let exit: { code: number | null; signal: string | null } | null = null;
  const failed = new Promise<{ status: string; detail: string }>((resolve) => {
    child.once("error", (error: NodeJS.ErrnoException) => resolve({ status: "failed", detail: error.code === "ENOENT" ? `${command[0]} is not installed` : `${command[0]} could not start` }));
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      // The caller learns how the session ended from its log; a callback that throws never reaches the process.
      if (typeof onEnd === "function") {
        try { void Promise.resolve(onEnd({ code, signal, log: readWhole(log) })).catch(() => {}); } catch { /* best effort */ }
      }
    });
  });
  child.unref();
  const deadline = now() + waitMs;
  for (;;) {
    const early = await Promise.race([failed, new Promise<null>((r) => setTimeout(r, ID_POLL_MS, null))]);
    if (early) return { ...early, log: basename(log) };
    const id = outputId(harness, readHead(log));
    if (id) {
      return {
        status: "started", detail: `${harness} started in ${where}`, log: basename(log),
        session: `${harness}#${sessionLabel(id)}`,
      };
    }
    const ended = exit as { code: number | null; signal: string | null } | null;
    if (ended && ended.code !== 0) return { status: "failed", detail: `${command[0]} exited ${ended.code ?? ended.signal}; see ${basename(log)}`, log: basename(log) };
    if (ended || now() >= deadline) {
      return { status: "started", detail: `${harness} started in ${where}; no session id printed yet`, log: basename(log) };
    }
  }
}

