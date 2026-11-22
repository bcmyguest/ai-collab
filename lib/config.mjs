import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_URL = "http://127.0.0.1:8794";
export const MAX_BODY_CHARS = 4000;
export const SESSION_LABEL = /^[a-f0-9]{16}$/;
export const AFK_WAIT_DEFAULT_S = 600;
// Phone approval wait; the approval hooks are registered with a 600 s timeout, so the wait ends first.
export const APPROVAL_DEFAULT_S = 540;
export const APPROVAL_MAX_S = 570;
// ntfy documents 4096 bytes, but the server answers 500 to a message of exactly 4096 (measured on 127.0.0.1:8794).
export const NTFY_MESSAGE_MAX_BYTES = 4095;

// 1-24 chars: lowercase letters and digits, single hyphens inside, no leading/trailing hyphen.
// Names never contain "--", which keeps topic names unambiguous across project/peer pairs.
const NAME_RE = /^(?=.{1,24}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
// A GitHub login: 1-39 letters, digits and single inner hyphens; the "by" field of UI-sent envelopes.
const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

export function sessionLabel(id) {
  return typeof id === "string" && id
    ? createHash("sha256").update(id).digest("hex").slice(0, 16)
    : "";
}

export function isValidName(name) {
  return typeof name === "string" && name.length <= 24 && NAME_RE.test(name);
}

export function isGithubLogin(login) {
  return typeof login === "string" && GITHUB_LOGIN.test(login);
}

// Topics are project-scoped, use only [a-z0-9-], and stay within ntfy's 64-char limit
// (worst case: 10 + 24 + 6 + 24 = 64).
export const statusTopic = (project) => `ai-collab-${project}--status`;
export const inboxTopic = (project, peer) => `ai-collab-${project}--to--${peer}`;
export const broadcastTopic = (project) => `ai-collab-${project}--to--all`;
// Read receipts for delivered messages; never read by claimInbox and never rendered as chat.
export const receiptsTopic = (project) => `ai-collab-${project}--receipts`;
// Hook activity stream; never read by claimInbox and never rendered as chat.
export const activityTopic = (project) => `ai-collab-${project}--activity`;

function intEnv(raw, fallback, min, max) {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function configDir(env = process.env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || homedir(), ".config"), "ai-collab");
}

/** The state directory: AI_COLLAB_STATE_DIR, else $XDG_STATE_HOME/ai-collab. */
export function stateDir(env = process.env) {
  return env.AI_COLLAB_STATE_DIR || path.join(env.XDG_STATE_HOME || path.join(env.HOME || homedir(), ".local", "state"), "ai-collab");
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}

/** defaults.json: url, tokenFile, peers and other settings shared by every auto-joined git repo; null when absent. */
export function autoDefaults(env = process.env) {
  const value = readJson(path.join(configDir(env), "defaults.json"));
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** A folder name as a project name: lowercase, other runs become one hyphen, at most 24 chars; "" when nothing is left. */
export function projectName(folder) {
  const name = String(folder).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24).replace(/^-+|-+$/g, "");
  return isValidName(name) ? name : "";
}

/** The main working tree of the git repo holding cwd (a linked worktree resolves to its main repo), or "". */
export function gitRoot(cwd) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, ".git");
    try {
      if (statSync(dotGit).isDirectory()) return dir;
      const gitdir = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
      const common = gitdir && /^(.*)[\/]\.git[\/]worktrees[\/][^\/]+$/.exec(path.resolve(dir, gitdir));
      return common ? common[1] : dir;
    } catch { /* not here */ }
    if (path.dirname(dir) === dir) return "";
  }
}

/** Entries of projects.json with an absolute root; [] when the file is missing or invalid. */
function explicitProjects(env) {
  const projects = readJson(path.join(configDir(env), "projects.json"));
  return Array.isArray(projects)
    ? projects.filter((project) => typeof project?.root === "string" && path.isAbsolute(project.root))
    : [];
}

/** projects.json entries, then auto-joined repos (recorded by their sessions) not shadowed by a projects.json name. */
export function listProjects(env = process.env) {
  const explicit = explicitProjects(env);
  const defaults = autoDefaults(env);
  if (!defaults) return explicit;
  const taken = new Set(explicit.map((p) => p.project));
  const dir = path.join(stateDir(env), "auto-projects");
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { /* none yet */ }
  const auto = [];
  for (const file of files) {
    const { root } = readJson(path.join(dir, file)) || {};
    const project = file.slice(0, -5);
    if (typeof root !== "string" || !path.isAbsolute(root) || taken.has(project) || projectName(path.basename(root)) !== project) continue;
    taken.add(project);
    auto.push({ ...defaults, root, project, auto: true });
  }
  return [...explicit, ...auto];
}

function projectSettings(env, cwd) {
  try {
    const current = path.resolve(cwd);
    const match = explicitProjects(env)
      .filter((project) => {
        const relative = path.relative(project.root, current);
        return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      })
      .sort((a, b) => path.resolve(b.root).length - path.resolve(a.root).length)[0];
    if (match) return match;
    // Any git repo auto-joins under its folder name when defaults.json exists, unless the repo has .ai-collab-off.
    // A repo at the home folder itself (dotfiles) never joins: harnesses that run hooks from home would all land there.
    const defaults = autoDefaults(env);
    const found = defaults ? gitRoot(current) : "";
    const root = found && path.resolve(found) !== path.resolve(env.HOME || homedir()) ? found : "";
    const project = root ? projectName(path.basename(root)) : "";
    return project && !existsSync(path.join(root, ".ai-collab-off")) ? { ...defaults, root, project, auto: true } : {};
  } catch {
    return {};
  }
}

/**
 * The environment a hook or MCP server of this harness should load its identity from. A child agent inherits its
 * parent's shell environment, so a session never takes AI_COLLAB_SESSION from it (hooks know their own session),
 * and a child (AI_COLLAB_PARENT set) takes its harness as its peer name instead of an inherited AI_COLLAB_PEER.
 */
export function ownEnv(env, host) {
  const out = { ...env };
  // Cursor's agent shell exports its conversation ID, so a harness started from it names its Cursor parent.
  if (!out.AI_COLLAB_PARENT && host && host !== "cursor" && out.CURSOR_CONVERSATION_ID) out.AI_COLLAB_PARENT = `cursor#${sessionLabel(out.CURSOR_CONVERSATION_ID)}`;
  if (!parentAddress(out) || !isValidName(host)) return out;
  delete out.AI_COLLAB_SESSION;
  if (host !== "cursor") delete out.CURSOR_CONVERSATION_ID;
  out.AI_COLLAB_PEER = host;
  return out;
}

/** The address of the agent that started this one (AI_COLLAB_PARENT), or "" when unset or malformed. */
export function parentAddress(env) {
  const value = String(env.AI_COLLAB_PARENT || "").trim();
  const [peer, label, ...extra] = value.split("#");
  return isValidName(peer) && peer !== "all" && SESSION_LABEL.test(label || "") && !extra.length ? value : "";
}

export function loadConfig(env = process.env, { cwd = process.cwd(), host = "", session = "" } = {}) {
  const settings = projectSettings(env, cwd);
  let token = env.AI_COLLAB_TOKEN;
  if (token === undefined && !env.AI_COLLAB_URL && typeof settings.tokenFile === "string" && path.isAbsolute(settings.tokenFile)) {
    try {
      token = readFileSync(settings.tokenFile, "utf8");
    } catch {
      return { enabled: false, reason: "could not read configured ntfy token file" };
    }
  }
  const label = session || env.AI_COLLAB_SESSION || sessionLabel(env.CURSOR_CONVERSATION_ID);
  const cfg = {
    url: String(env.AI_COLLAB_URL || settings.url || DEFAULT_URL).trim().replace(/\/+$/, ""),
    token: String(token || "").trim(),
    project: String(env.AI_COLLAB_PROJECT || settings.project || "").trim(),
    peer: String(env.AI_COLLAB_PEER || (settings.project && (host || (env.CURSOR_CONVERSATION_ID ? "cursor" : ""))) || "").trim(),
    peers: [],
    session: SESSION_LABEL.test(label) ? label : "",
    stateDir: stateDir(env),
    timeoutMs: intEnv(env.AI_COLLAB_TIMEOUT_MS, 2000, 200, 15000),
    pollIntervalMs: intEnv(env.AI_COLLAB_POLL_INTERVAL_MS, 10000, 0, 3600000),
    afkWaitS: intEnv(env.AI_COLLAB_AFK_WAIT_S ?? settings.afkWaitSeconds, AFK_WAIT_DEFAULT_S, 0, 86400),
    stopCap: intEnv(env.AI_COLLAB_STOP_CAP, 5, 0, 50),
    stopPollMs: intEnv(env.AI_COLLAB_STOP_POLL_MS, 5000, 50, 60000),
    importantMaxS: intEnv(env.AI_COLLAB_IMPORTANT_MAX_S, 86400, 0, 7 * 86400),
    approvalS: intEnv(env.AI_COLLAB_APPROVAL_S, APPROVAL_DEFAULT_S, 0, APPROVAL_MAX_S),
    activity: !/^(off|0|false|no)$/i.test(String(env.AI_COLLAB_ACTIVITY ?? settings.activity ?? "on").trim()),
    wire: String(env.AI_COLLAB_WIRE ?? settings.wire ?? "").trim() === "agui" ? "agui" : "legacy",
    enabled: false,
    reason: "",
    ...(settings.auto && !env.AI_COLLAB_PROJECT ? { auto: true, root: settings.root } : {}),
  };

  const problems = [];
  if (!cfg.project || !cfg.peer) problems.push("set AI_COLLAB_PROJECT and AI_COLLAB_PEER to enable");
  if (cfg.project && !isValidName(cfg.project)) {
    problems.push("AI_COLLAB_PROJECT must be 1-24 chars of a-z, 0-9 and single hyphens");
  }
  if (cfg.peer && (!isValidName(cfg.peer) || cfg.peer === "all")) {
    problems.push("AI_COLLAB_PEER must be 1-24 chars of a-z, 0-9 and single hyphens, not 'all'");
  }

  const listed = String(env.AI_COLLAB_PEERS || settings.peers || "").split(",").map((s) => s.trim()).filter(Boolean);
  const invalid = listed.filter((p) => !isValidName(p) || p === "all");
  if (invalid.length) problems.push(`AI_COLLAB_PEERS has invalid name(s): ${invalid.join(", ")}`);
  cfg.peers = [...new Set(listed)];

  try {
    const u = new URL(cfg.url);
    if (!/^https?:$/.test(u.protocol)) problems.push("AI_COLLAB_URL must be http or https");
  } catch {
    problems.push("AI_COLLAB_URL is not a valid URL");
  }

  // A parent that is this very session (its own Bash exports AI_COLLAB_PARENT for its children) is no parent.
  const parent = parentAddress(env);
  cfg.parent = parent && parent !== `${cfg.peer}#${cfg.session}` ? parent : "";

  cfg.enabled = problems.length === 0;
  cfg.reason = problems.join("; ");
  return cfg;
}

/** One config per projects.json entry, loaded from that entry's root; per-session env vars are ignored. */
export function loadProjects(env = process.env, { host = "" } = {}) {
  const { AI_COLLAB_PROJECT, AI_COLLAB_PEER, AI_COLLAB_PEERS, AI_COLLAB_SESSION, ...shared } = env;
  const found = new Map();
  for (const entry of listProjects(env)) {
    if (!isValidName(entry.project)) continue;
    const cfg = loadConfig(shared, { cwd: entry.root, host });
    if (cfg.enabled && cfg.project === entry.project && !found.has(cfg.project)) found.set(cfg.project, cfg);
  }
  return [...found.values()];
}
