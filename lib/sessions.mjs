import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, sep } from "node:path";
import { sessionLabel } from "./config.mjs";
import { runningJobs } from "./job.mjs";
import { codexRequiredRunCodeArgs, REQUIRE_RUN_CODE_ENV } from "./code-mode.mjs";
import { CODEX_HOOK_TRUST } from "./start.mjs";
import { isRunning } from "./process.mjs";
import { withLock, writeState } from "./state.mjs";
import { stripControl } from "./format.mjs";
import { MACHINE_NAME } from "./names.mjs";

const ACTIVITY_MAX = 200;
const TAGS_MAX = 10;
const TAG = /^[a-zA-Z0-9:./#_-]{1,40}$/;
const ADDRESS = /^[a-z0-9-]+#[a-f0-9]{16}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,39}$/;
const MODEL = /^[a-zA-Z0-9._:/#+-]{1,120}$/;

function registry(cfg) {
  return join(cfg.stateDir, cfg.project, "registry");
}

// Registry file of this config's own session.
function ownFile(cfg) {
  return join(registry(cfg), `${cfg.peer}#${cfg.session}.json`);
}

// The session's own registry entry, or {}.
function readOwn(cfg) {
  try { return JSON.parse(readFileSync(ownFile(cfg), "utf8")) || {}; } catch { return {}; }
}

/**
 * Records the session; operatorPromptAt (ms) marks a prompt the operator typed, and is kept across later writes,
 * like parentNotifiedAt. parent is the address of the agent that started this one.
 */
export async function recordSession(cfg, { id, cwd, harness, event, proc, operatorPromptAt, parent, name, model, requireRunCode }) {
  if (!cfg.session || cfg.session !== sessionLabel(id) || id.length > 256 || !isAbsolute(cwd)) return;
  const address = `${cfg.peer}#${cfg.session}`;
  const file = ownFile(cfg);
  await withLock(file, () => {
    const last = operatorPromptAt || lastOperatorPromptAt(cfg);
    const own = readOwn(cfg);
    const { parentNotifiedAt } = own;
    // The harness's session name (lib/names.mjs) stays until the harness reports a new one.
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

/** The identity fields set_identity stores, validated: name, activity line, tags. */
function cleanIdentity({ name, activity, tags }) {
  return {
    ...(typeof name === "string" && NAME.test(name) ? { name } : {}),
    ...(typeof activity === "string" && activity.trim() && activity.length <= ACTIVITY_MAX ? { activity: stripControl(activity).replace(/\s+/g, " ").trim() } : {}),
    ...(Array.isArray(tags) && tags.length && tags.length <= TAGS_MAX && tags.every((tag) => typeof tag === "string" && TAG.test(tag)) ? { tags } : {}),
  };
}

/**
 * Stores this session's name, activity line and tags in its registry entry, shown by list_agents.
 * A field left undefined keeps its value; "" or [] clears it. Throws until a hook has registered the session.
 */
export async function setIdentity(cfg, { name, activity, tags } = {}) {
  if (!cfg.session) throw new Error("Pass the session label supplied by the ai-collab hook");
  if (name !== undefined && name !== "" && !(typeof name === "string" && NAME.test(name))) throw new Error("name must be 1-40 letters, digits, spaces, or . _ -");
  if (activity !== undefined && (typeof activity !== "string" || activity.length > ACTIVITY_MAX)) throw new Error(`activity must be at most ${ACTIVITY_MAX} characters`);
  if (tags !== undefined && (!Array.isArray(tags) || tags.length > TAGS_MAX || !tags.every((tag) => typeof tag === "string" && TAG.test(tag)))) {
    throw new Error(`tags: at most ${TAGS_MAX}, each 1-40 characters of a-z, A-Z, 0-9 and : . / # _ -`);
  }
  const file = ownFile(cfg);
  const r = await withLock(file, () => {
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
  return r.value;
}

/** Marks the parent as told about this session; true only the first time. */
export async function claimParentNotice(cfg) {
  if (!cfg.session) return false;
  const file = ownFile(cfg);
  const r = await withLock(file, () => {
    const own = readOwn(cfg);
    if (!own.id || own.parentNotifiedAt) return false;
    writeState(file, { ...own, parentNotifiedAt: Date.now() });
    return true;
  });
  return r.locked && r.value;
}

/** When the operator last typed a prompt in this session (ms), or 0. */
export function lastOperatorPromptAt(cfg) {
  if (!cfg.session) return 0;
  try {
    const at = JSON.parse(readFileSync(ownFile(cfg), "utf8")).lastOperatorPromptAt;
    return Number.isSafeInteger(at) && at > 0 ? at : 0;
  } catch {
    return 0;
  }
}

// How to continue a session headless with a new prompt; resumed runs deliver its queued messages through its hooks.
// Codex's run carries CODEX_HOOK_TRUST and --skip-git-repo-check: without them a run resumed in a fresh worktree
// fires no hooks, or refuses to start at all (lib/start.mjs explains the trust rule).
const RESUME = {
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

/** Sessions on this machine for agents to find each other, newest activity first. Local only: includes cwd and the resume command. */
export function sessionDirectory(cfg) {
  return listSessions(cfg).sort((a, b) => (b.seenAt || 0) - (a.seenAt || 0)).map((s) => ({
    address: s.id, harness: s.harness, online: s.online, ...(s.runningJobs ? { runningJobs: s.runningJobs } : {}), lastActive: s.seenAt ? new Date(s.seenAt).toISOString() : "",
    ...(s.parent ? { parent: s.parent } : {}), cwd: s.cwd, ...(RESUME[s.harness] && /^[\w.-]{1,128}$/.test(s.sessionId) ? { resume: `${s.requireRunCode === true ? `${REQUIRE_RUN_CODE_ENV}=1 ` : ""}${RESUME[s.harness](s.sessionId, s.requireRunCode === true)}` } : {}),
  }));
}

/**
 * list_agents: this project's sessions with their set_identity fields, newest activity first; online ones only unless all.
 * tags keeps only sessions that carry every listed tag. Shows no cwd or resume command (list_sessions has those).
 */
export function agentDirectory(cfg, { all = false, tags = [] } = {}) {
  const has = (s) => tags.every((tag) => cleanIdentity(s).tags?.includes(tag));
  return listSessions(cfg).filter((s) => (all || s.online || s.runningJobs) && has(s)).sort((a, b) => (b.seenAt || 0) - (a.seenAt || 0)).map((s) => ({
    address: s.id, harness: s.harness, project: cfg.project, ...cleanIdentity(s), online: s.online, ...(s.runningJobs ? { runningJobs: s.runningJobs } : {}),
    ...(typeof s.identityName === "string" && /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,39}$/.test(s.identityName) ? { identityName: s.identityName } : {}),
    lastActive: s.seenAt ? new Date(s.seenAt).toISOString() : "", ...(s.parent ? { parent: s.parent } : {}),
  }));
}

// OpenCode records the shared `opencode serve` process. A stopped session is offline while that server stays up.
function sessionOnline(session) {
  if (!isRunning({ pid: session.pid, start: session.pidStart })) return false;
  if (session.harness === "opencode" && /^(stop|sessionend|ended)$/i.test(session.event || "")) return false;
  return true;
}

export function listSessions(cfg) {
  let files;
  try { files = readdirSync(registry(cfg)); } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return files.filter(file => /^[a-z0-9-]+#[a-f0-9]{16}\.json$/.test(file)).flatMap(file => {
    try {
      const session = JSON.parse(readFileSync(join(registry(cfg), file), "utf8"));
      const [peer, label] = session.id.split("#");
      if (file !== session.id + ".json" || sessionLabel(session.sessionId) !== label ||
          (cfg.peers.length && !cfg.peers.includes(peer))) return [];
      const jobs = runningJobs(registry(cfg), session.id, files);
      return [{
        ...session, peer, session: label,
        ...(jobs ? { runningJobs: jobs } : {}),
        online: sessionOnline(session),
      }];
    } catch {
      return [];
    }
  });
}

/** Deletes an offline session's registry file; throws status 400/404/409 for a bad address, an unknown session, or a running one. */
export function disposeSession(cfg, address) {
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  if (typeof address !== "string" || !ADDRESS.test(address)) fail(400, "Invalid session address");
  const session = listSessions(cfg).find(item => item.id === address);
  if (!session) fail(404, "Unknown session");
  if (session.online || session.runningJobs) fail(409, "The session is running");
  rmSync(join(registry(cfg), `${address}.json`), { force: true });
}

/**
 * The worktree folder a cwd belongs to, or "": the first folder under a worktrees directory, so a session started in
 * one of its subfolders still names (and checks) the worktree itself.
 */
export function worktreeRoot(cwd, root = "") {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return "";
  const trees = root ? join(root, ".claude", "worktrees") + sep : "";
  if (trees && cwd.startsWith(trees)) return trees + cwd.slice(trees.length).split(sep)[0];
  const match = cwd.match(/^(.*\/\.?(?:claude\/)?worktrees\/[^/]+)/);
  return match ? match[1] : "";
}

/** An offline session whose worktree was deleted: nothing can resume there, so the session cards leave it out. */
export function worktreeGone({ cwd, online, sandbox }, root = "") {
  if (online || sandbox) return false;
  const tree = worktreeRoot(cwd, root);
  if (!tree) return false;
  try { return !statSync(tree).isDirectory(); } catch { return true; }
}

/** Where a session runs: "sandbox", "folder" (the project root), "worktree <name>", else the cwd with ~ for home; "" without a cwd. */
export function sessionPlace({ cwd, sandbox }, root = "") {
  if (sandbox) return "sandbox";
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return "";
  if (root && cwd === root) return "folder";
  const trees = root ? join(root, ".claude", "worktrees") + sep : "";
  if (trees && cwd.startsWith(trees)) return "worktree " + cwd.slice(trees.length).split(sep)[0];
  if (/\/\.?(claude\/)?worktrees\/[^/]+\/?$/.test(cwd)) return "worktree " + basename(cwd);
  const home = homedir();
  return cwd === home || cwd.startsWith(home + sep) ? "~" + cwd.slice(home.length) : cwd;
}
