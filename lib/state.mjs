/**
 * Durable per-peer state: topic cursors, recent delivered ids, last poll time, latest operator mode.
 * Hooks keep one cursor per session. The manual inbox keeps one cursor per peer.
 */
import fs from "node:fs";
import path from "node:path";

export function statePath(cfg) {
  if (!cfg.session) return path.join(cfg.stateDir, cfg.project, `${cfg.peer}.json`);
  return path.join(cfg.stateDir, cfg.project, "sessions", cfg.peer, `${cfg.session}.json`);
}

export function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    if (s && typeof s === "object") {
      return {
        lastPollAt: Number(s.lastPollAt) || 0,
        topics: s.topics && typeof s.topics === "object" ? s.topics : {},
        seen: Array.isArray(s.seen) ? s.seen.filter((x) => typeof x === "string") : [],
        reserved: s.reserved && typeof s.reserved === "object" ? Object.fromEntries(Object.entries(s.reserved).filter(([, t]) => Number.isFinite(t))) : {},
        ...(s.mode && typeof s.mode === "object" ? { mode: s.mode } : {}),
        ...(Number.isFinite(s.modeNotedTs) ? { modeNotedTs: s.modeNotedTs } : {}),
      };
    }
  } catch { /* missing or corrupt: start fresh */ }
  return { lastPollAt: 0, topics: {}, seen: [], reserved: {} };
}

export function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Run fn while holding the lock. Returns { locked: false } if the lock
 * could not be taken within waitMs (caller should fail open).
 */
export async function withLock(file, fn, { waitMs = 1500, staleMs = 40000 } = {}) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
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
