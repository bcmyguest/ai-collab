/** Shared persistence: JSON and text files written atomically, and lock directories for read-modify-write. */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type StateConfig = { stateDir: string; project: string; peer: string; session?: string };
export type LockOptions = { waitMs?: number; staleMs?: number };
export type LockResult<T> = { locked: false } | { locked: true; value: T };
type Owner = { pid: number; host: string; token: string };

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
const OWNER_FILE = "owner.json";

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

function readOwner(lock: string): Owner | undefined {
  return readJson<Owner>(path.join(lock, OWNER_FILE));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** A lock is stale when its owner pid on this host is gone, else when it is older than staleMs (no usable owner). */
function isStale(lock: string, owner: Owner | undefined, staleMs: number): boolean {
  if (owner && Number.isInteger(owner.pid) && owner.host === os.hostname()) return !pidAlive(owner.pid);
  return Date.now() - fs.statSync(lock).mtimeMs > staleMs;
}

/** Takes the lock by renaming a staged dir with its owner file into place; false when another holder has it. */
function takeLock(lock: string, token: string): boolean {
  if (fs.existsSync(lock)) return false; // rename would replace an empty lock dir
  const staging = `${lock}.${process.pid}.${randomBytes(6).toString("hex")}.new`;
  fs.mkdirSync(staging);
  try {
    writeJson(path.join(staging, OWNER_FILE), { pid: process.pid, host: os.hostname(), token });
    fs.renameSync(staging, lock);
    return true;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTEMPTY") return false;
    throw error;
  }
}

/** Breaks a stale lock by renaming it to a unique tombstone, so one waiter wins; true when the caller should retry at once. */
function reclaimStale(lock: string, staleMs: number): boolean {
  let owner: Owner | undefined;
  try {
    owner = readOwner(lock);
    if (!isStale(lock, owner, staleMs)) return false;
  } catch {
    return true; // vanished: retry
  }
  const tomb = `${lock}.${process.pid}.${randomBytes(6).toString("hex")}.broken`;
  try {
    fs.renameSync(lock, tomb);
  } catch {
    return true; // another waiter broke or released it
  }
  if (readOwner(tomb)?.token !== owner?.token) {
    // Moved a fresh lock taken after the judgement: put it back.
    try { fs.renameSync(tomb, lock); } catch { /* lock taken again: keep the tombstone */ }
    return true;
  }
  fs.rmSync(tomb, { recursive: true, force: true });
  return true;
}

/** Removes the lock only while this process still owns it. */
function releaseLock(lock: string, token: string): void {
  if (readOwner(lock)?.token === token) fs.rmSync(lock, { recursive: true, force: true });
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
  while (!takeLock(lock, token)) {
    if (reclaimStale(lock, staleMs)) continue;
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
  while (!takeLock(lock, token)) {
    if (reclaimStale(lock, staleMs)) continue;
    if (Date.now() >= deadline) return { locked: false };
    Atomics.wait(SLEEP_CELL, 0, 0, 25);
  }
  try {
    return { locked: true, value: fn() };
  } finally {
    releaseLock(lock, token);
  }
}
