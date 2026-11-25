/**
 * Durable per-peer state: topic cursors, recent delivered ids, last poll time, latest operator mode.
 * Hooks keep one cursor per session. The manual inbox keeps one cursor per peer.
 */
import { readJson, writeJson } from "./store.ts";

export { statePath, withLock, withLockSync } from "./store.ts";

export function readState(file) {
  const s = readJson(file);
  if (s && typeof s === "object") {
    return {
      lastPollAt: Number(s.lastPollAt) || 0,
      topics: s.topics && typeof s.topics === "object" ? s.topics : {},
      seen: Array.isArray(s.seen) ? s.seen.filter((x) => typeof x === "string") : [],
      reserved: s.reserved && typeof s.reserved === "object" ? Object.fromEntries(Object.entries(s.reserved).filter(([, v]) => Number.isFinite(v) || Number.isFinite(v?.until))) : {},
      ...(s.queue && typeof s.queue === "object" ? { queue: s.queue } : {}),
      ...(s.mode && typeof s.mode === "object" ? { mode: s.mode } : {}),
      ...(Number.isFinite(s.modeNotedTs) ? { modeNotedTs: s.modeNotedTs } : {}),
    };
  }
  return { lastPollAt: 0, topics: {}, seen: [], reserved: {} };
}

export function writeState(file, state) {
  writeJson(file, state);
}
