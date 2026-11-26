// Session registry, owned records and display names: what hooks, the runner and the UI read and write.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, sep } from "node:path";
import { sessionLabel, SESSION_LABEL } from "../config.mjs";
import { codexRequiredRunCodeArgs, REQUIRE_RUN_CODE_ENV } from "../code-mode.mjs";
import { CODEX_HOOK_TRUST } from "../harness.ts";
import { runningJobs } from "../job.mjs";
import { stripControl } from "../format.mjs";
import { isRunning } from "../process.mjs";
import { withLock, writeState } from "../state.mjs";

type Proc = { pid: number; start: string };
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
type OwnedStatus = "starting" | "idle" | "running" | "ended";
type OwnedRecord = { v: 1; label: string; status: OwnedStatus; updatedAt: number; [field: string]: unknown };
export type SessionCfg = { stateDir: string; project: string; peer: string; session: string; peers: string[]; root?: string; auto?: boolean; enabled?: boolean };

const ACTIVITY_MAX = 200;
const TAGS_MAX = 10;
const TAG = /^[a-zA-Z0-9:./#_-]{1,40}$/;
const ADDRESS = /^[a-z0-9-]+#[a-f0-9]{16}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,39}$/;
const MODEL = /^[a-zA-Z0-9._:/#+-]{1,120}$/;
const REGISTRY_FILE = /^[a-z0-9-]+#[a-f0-9]{16}\.json$/;
const OWNED_LABEL_FILE = /^[a-f0-9]{16}\.json$/;
const OWNED_STATUSES: readonly OwnedStatus[] = ["starting", "idle", "running", "ended"];

const NAME_MAX = 80;
const INDEX_TAIL_BYTES = 256 * 1024;
// A worktree or subagent label such as agent-a3c26b3960e76171e repeats the address and names nothing.
const MACHINE_NAME = /^agent-[0-9a-f]{8,}$/i;

// Headless resume command per harness; Codex needs CODEX_HOOK_TRUST or a fresh worktree fires no hooks.
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

/** Stores name, activity and tags in this session's registry entry; undefined keeps a field, "" or [] clears it. */
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

/** list_agents: this project's sessions with their set_identity fields, newest first; online only unless all. */
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

/** The worktree folder a cwd belongs to, or "": its first folder under a worktrees directory. */
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

function ownedDir(cfg: SessionCfg): string {
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

/** True when the label has an unended owned record; only the runner's own process stands down (lib/family.mjs). */
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
