// Systemd user scopes for children, so a restart of the unit that started them does not kill them; also PATH lookup.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { Command } from "../harness.ts";

type ScopeVerdict = { ok: boolean; why: string; at?: number };
type LaunchStart = { file: string; args: string[]; scoped: boolean; unit: string; why: string };

const SCOPE_ENV = "AI_COLLAB_SCOPE";
const UNIT_CHARS = /[^a-zA-Z0-9]/g;
const SCOPE_LABEL_MAX = 40;
const PROBE_TIMEOUT_MS = 5000;
// A failed probe is retried after this long, so a briefly busy manager does not disable scoping for good.
const PROBE_RETRY_MS = 60_000;
const probed = new Map<string, ScopeVerdict>();

// The UTC time as a compact stamp: 20260325T101500Z.
export function utcStamp(at: number): string {
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

/** Whether a scope may be tried: systemd-run installed, a systemd parent to leave, a user manager; {ok, why}. */
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

/** The systemd-run argv that runs [file, ...args] in a scope; `--` guards flags, RuntimeMaxSec holds the deadline. */
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

/** The spawn command for one unit of work: wrapped in a scope when this host can make one; {file, args, scoped, unit, why}. */
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
