/** Shared persistence: JSON and text files written atomically, and lock directories for read-modify-write. */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type StateConfig = { stateDir: string; project: string; peer: string; session?: string };
export type LockOptions = { waitMs?: number; staleMs?: number };
export type LockResult<T> = { locked: false } | { locked: true; value: T };
type Owner = { pid: number; host: string; token: string; start: number | null };

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
const OWNER_FILE = "owner.json";
const BREAKER_SUFFIX = ".break";
const RELEASE_SUFFIX = ".rel.";
const BREAKER_STALE_MS = 5000;
const CEILING_FACTOR = 10;

/** The per-peer state file: one per project and peer, or one per session when the config names a session. */
export function statePath(cfg: StateConfig): string {
  if (!cfg.session) return path.join(cfg.stateDir, cfg.project, `${cfg.peer}.json`);
  return path.join(cfg.stateDir, cfg.project, "sessions", cfg.peer, `${cfg.session}.json`);
}

/** The parsed file, or undefined when it is missing or not JSON. */
export function readJson<T = unknown>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Writes text through a temp file, mode 0600 and a rename, so a reader never sees a partial file. */
export function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, text, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** Writes value as JSON with a trailing newline; indent 0 writes one line. */
export function writeJson(file: string, value: unknown, { indent = 0 }: { indent?: number } = {}): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, indent)}\n`);
}

/** Read-modify-write under the file's lock: fn gets the current value and returns the next; throws when the lock stays busy. */
export function updateJson<T>(file: string, fn: (current: T | undefined) => T, { waitMs = 2000 }: { waitMs?: number } = {}): T {
  const locked = withLockSync(file, () => {
    const next = fn(readJson<T>(file));
    writeJson(file, next, { indent: 2 });
    return next;
  }, { waitMs });
  if (!locked.locked) throw new Error(`${file} is busy; retry`);
  return locked.value;
}

/** The process start time from /proc/<pid>/stat (field 22, clock ticks since boot), or null when unreadable. */
function procStart(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const start = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    return Number.isFinite(start) ? start : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readOwner(lock: string): Owner | undefined {
  return readJson<Owner>(path.join(lock, OWNER_FILE));
}

/**
 * Without owner.json, stale after staleMs by mtime. With one on this host, stale when its pid is gone,
 * reused (start time differs), or the lock is older than CEILING_FACTOR x staleMs.
 */
function isStale(lock: string, staleMs: number): boolean {
  const ageMs = Date.now() - fs.statSync(lock).mtimeMs;
  const owner = readOwner(lock);
  if (!owner || owner.host !== os.hostname()) return ageMs > staleMs;
  if (ageMs > CEILING_FACTOR * staleMs) return true;
  if (!pidAlive(owner.pid)) return true;
  const now = procStart(owner.pid);
  return typeof owner.start === "number" && now !== null && now !== owner.start;
}

/** Takes the lock with mkdir, which fails on any existing dir, then records the owner inside; false when held. */
function takeLock(lock: string, token: string): boolean {
  try {
    fs.mkdirSync(lock);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  // A waiter may break this ownerless dir after staleMs and another process may make a new one, so owner.json is
  // written only into a dir that still has none: the temp write fails on a missing dir, the link on an existing owner.
  const owner = path.join(lock, OWNER_FILE);
  const temp = `${owner}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ pid: process.pid, host: os.hostname(), token, start: procStart(process.pid) })}\n`, { mode: 0o600 });
    fs.linkSync(temp, owner);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EEXIST") return false;
    fs.rmSync(lock, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return true;
}

/** Removes a breaker dir left by a crashed breaker; its mtime is the only clock. Accepted: a race needs a crash inside the ~1 ms .break window. */
function clearOldBreaker(breaker: string): void {
  try {
    if (Date.now() - fs.statSync(breaker).mtimeMs > BREAKER_STALE_MS) fs.rmdirSync(breaker);
  } catch { /* gone or busy: nothing to clear */ }
}

/** Breaks the lock if it is still stale, under a breaker mutex; true when the lock was removed. */
function reclaimStale(lock: string, staleMs: number): boolean {
  try {
    if (!isStale(lock, staleMs)) return false;
  } catch {
    return false; // vanished
  }
  const breaker = `${lock}${BREAKER_SUFFIX}`;
  try {
    fs.mkdirSync(breaker);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") clearOldBreaker(breaker); // accepted race: see clearOldBreaker
    return false;
  }
  let removed = false;
  try {
    if (isStale(lock, staleMs)) {
      fs.rmSync(lock, { recursive: true, force: true });
      removed = true;
      clearOldTombs(lock, staleMs);
    }
  } catch { /* vanished */ } finally {
    try { fs.rmdirSync(breaker); } catch { /* already gone */ }
  }
  return removed;
}

function attemptLock(lock: string, token: string, staleMs: number): boolean {
  return takeLock(lock, token) || (reclaimStale(lock, staleMs) && takeLock(lock, token));
}

/** Removes release tombs named before staleMs ago: a releaser that crashed mid-release left them. */
function clearOldTombs(lock: string, staleMs: number): void {
  const dir = path.dirname(lock);
  const prefix = `${path.basename(lock)}${RELEASE_SUFFIX}`;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const releasedAt = Number(name.slice(prefix.length).split(".")[1]);
    if (Date.now() - releasedAt > staleMs) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

/**
 * Removes the lock only while it holds our token. The lock is renamed to a tomb first, so an
 * unlink never lands on another owner's dir; a tomb that is not ours goes back to the lock path.
 */
function releaseLock(lock: string, token: string): void {
  try {
    if (readOwner(lock)?.token !== token) return;
    const tomb = `${lock}${RELEASE_SUFFIX}${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
    fs.renameSync(lock, tomb);
    if (readOwner(tomb)?.token === token) {
      fs.rmSync(tomb, { recursive: true, force: true });
      return;
    }
    try {
      fs.renameSync(tomb, lock);
    } catch (error) {
      process.stderr.write(`store: left ${tomb} after a release race: ${(error as Error).message}\n`);
    }
  } catch (error) {
    process.stderr.write(`store: could not release ${lock}: ${(error as Error).message}\n`);
  }
}

/**
 * Run fn while holding the lock. Returns { locked: false } if the lock
 * could not be taken within waitMs (caller should fail open).
 */
export async function withLock<T>(file: string, fn: () => Promise<T>, { waitMs = 1500, staleMs = 40000 }: LockOptions = {}): Promise<LockResult<T>> {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(8).toString("hex");
  const deadline = Date.now() + waitMs;
  while (!attemptLock(lock, token, staleMs)) {
    if (Date.now() >= deadline) return { locked: false };
    await new Promise((r) => setTimeout(r, 25));
  }
  try {
    return { locked: true, value: await fn() };
  } finally {
    releaseLock(lock, token);
  }
}

/** withLock for synchronous work: waits with blocking sleeps, same lock directory and staleness rule. */
export function withLockSync<T>(file: string, fn: () => T, { waitMs = 1500, staleMs = 40000 }: LockOptions = {}): LockResult<T> {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(8).toString("hex");
  const deadline = Date.now() + waitMs;
  while (!attemptLock(lock, token, staleMs)) {
    if (Date.now() >= deadline) return { locked: false };
    Atomics.wait(SLEEP_CELL, 0, 0, 25);
  }
  try {
    return { locked: true, value: fn() };
  } finally {
    releaseLock(lock, token);
  }
}
