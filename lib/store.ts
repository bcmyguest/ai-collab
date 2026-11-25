/** Shared persistence: JSON and text files written atomically, and lock directories for read-modify-write. */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type StateConfig = { stateDir: string; project: string; peer: string; session?: string };
export type LockOptions = { waitMs?: number; staleMs?: number };
export type LockResult<T> = { locked: false } | { locked: true; value: T };

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

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

/**
 * Run fn while holding the lock. Returns { locked: false } if the lock
 * could not be taken within waitMs (caller should fail open).
 */
export async function withLock<T>(file: string, fn: () => Promise<T>, { waitMs = 1500, staleMs = 40000 }: LockOptions = {}): Promise<LockResult<T>> {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) {
          fs.rmdirSync(lock);
          continue;
        }
      } catch { /* vanished: retry */ }
      if (Date.now() >= deadline) return { locked: false };
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try {
    return { locked: true, value: await fn() };
  } finally {
    try { fs.rmdirSync(lock); } catch { /* already gone */ }
  }
}

/** withLock for synchronous work: waits with blocking sleeps, same lock directory and staleness rule. */
export function withLockSync<T>(file: string, fn: () => T, { waitMs = 1500, staleMs = 40000 }: LockOptions = {}): LockResult<T> {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) {
          fs.rmdirSync(lock);
          continue;
        }
      } catch { /* vanished: retry */ }
      if (Date.now() >= deadline) return { locked: false };
      Atomics.wait(SLEEP_CELL, 0, 0, 25);
    }
  }
  try {
    return { locked: true, value: fn() };
  } finally {
    try { fs.rmdirSync(lock); } catch { /* already gone */ }
  }
}
