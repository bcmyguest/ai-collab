/**
 * Runs a child in its own transient systemd user scope, so a restart of the unit that started it (the UI, the runner)
 * does not kill it: a unit's default KillMode=control-group kills every process in its cgroup, and a scope is a
 * sibling cgroup, not a child. The scope execs the payload, so the caller keeps its stdio, exit code and PID, and
 * --collect drops the unit once the payload exits.
 *
 * A scope is used only where it helps: systemd-run installed, a user manager reachable, and this process itself
 * started by systemd (a process started by hand leaves nothing to escape). AI_COLLAB_SCOPE=on forces it on, =off off.
 * Everywhere else, and whenever a live probe of systemd-run fails, callers spawn exactly as they did before.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export const SCOPE_ENV = "AI_COLLAB_SCOPE";
const UNIT_CHARS = /[^a-zA-Z0-9]/g;
const LABEL_MAX = 40;
const PROBE_TIMEOUT_MS = 5000;
// A failed probe is retried after this long: a manager that is briefly busy must not disable scoping for good.
const PROBE_RETRY_MS = 60_000;
// One live verdict per systemd-run binary, with the time it was taken.
const probed = new Map();

const stamp = (at) => new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** First executable named systemd-run on a PATH value, or "". */
export function systemdRunOnPath(path = "") {
  for (const dir of path.split(delimiter).filter((d) => isAbsolute(d))) {
    try {
      accessSync(join(dir, "systemd-run"), constants.X_OK);
      return join(dir, "systemd-run");
    } catch { /* next */ }
  }
  return "";
}

/** A transient unit name: ai-collab-<kind>-<label>-<UTC stamp>-<random>, legal for systemd and unique per start. */
export function scopeUnitName(kind, at, label = "", random = () => randomBytes(3).toString("hex")) {
  const slug = String(label).toLowerCase().replace(UNIT_CHARS, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, LABEL_MAX);
  return ["ai-collab", kind, slug, stamp(at), random()].filter(Boolean).join("-");
}

/**
 * Whether trying a scope is right here: systemd-run is installed, this process is a systemd unit with a cgroup to
 * leave, and a user manager socket is there. Returns {ok, why}; why names the reason in either case.
 */
export function scopeSupport({ env = process.env, systemdRun = "" } = {}) {
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
function liveProbe(systemdRun, env) {
  try {
    // node with an empty program: always present, quick, and proves the manager can start a process in a scope.
    execFileSync(systemdRun, ["--user", "--scope", "--quiet", "--collect", `--unit=${scopeUnitName("probe", Date.now())}`, "--", process.execPath, "-e", ""],
      { env, stdio: ["ignore", "ignore", "pipe"], timeout: PROBE_TIMEOUT_MS });
    return { ok: true, why: "systemd-run --user --scope" };
  } catch (error) {
    const line = String(error.stderr || error.message).trim().split("\n")[0] || "no output";
    return { ok: false, why: `systemd-run cannot make a scope: ${line}` };
  }
}

/** scopeSupport plus one cached live probe of this systemd-run: the verdict a launch may rely on. */
export function scopeAvailable({ env = process.env, systemdRun = systemdRunOnPath(env.PATH), now = Date.now } = {}) {
  const support = scopeSupport({ env, systemdRun });
  if (!support.ok) return support;
  const cached = probed.get(systemdRun);
  // A pass is kept for the process's life; a failure is retried later, so a transient outage does not stick.
  if (cached && (cached.ok || now() - cached.at < PROBE_RETRY_MS)) return cached;
  const verdict = { ...liveProbe(systemdRun, env), at: now() };
  probed.set(systemdRun, verdict);
  return verdict;
}

/** Forgets the cached probes, so a test may change what systemd-run does mid-run. */
export function resetScopeProbe() {
  probed.clear();
}

/**
 * The argv that runs [file, ...args] in a transient scope. `--` separates the command, so a harness flag is never read
 * as a systemd-run option; --quiet keeps systemd-run's own notice out of the caller's log. RuntimeMaxSec holds the
 * payload to its deadline even if the caller dies, which is what a timeout means once the payload outlives it.
 */
export function scopeWrap([file, ...args], { systemdRun, unit, cwd = "", description = "", runtimeMaxSec }) {
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
export function scopeLaunch([file, ...args], { env = process.env, path = env.PATH || "", kind = "session", label = "", at = Date.now(), cwd = "", description = "", runtimeMaxSec } = {}) {
  const systemdRun = systemdRunOnPath(path);
  const available = scopeAvailable({ env, systemdRun });
  if (!available.ok) return { file, args, scoped: false, unit: "", why: available.why };
  const unit = scopeUnitName(kind, at, label);
  const wrapped = scopeWrap([file, ...args], { systemdRun, unit, cwd, description, runtimeMaxSec });
  return { file: wrapped[0], args: wrapped[1], scoped: true, unit, why: available.why };
}
