/**
 * Durable per-peer state: topic cursors, recent delivered ids, last poll time, latest operator mode.
 * Hooks keep one cursor per session. The manual inbox keeps one cursor per peer.
 */
import { readJson, writeJson } from "./store.ts";

export { statePath, withLock, withLockSync } from "./store.ts";

// oxlint-disable-next-line typescript/no-explicit-any -- state files are JSON written by older releases; readers narrow each field
type Json = any;

/** The state file as read back; the nested records stay JSON as the writers left them. */
export interface PeerState {
  lastPollAt: number;
  topics: Record<string, Json>;
  seen: string[];
  reserved: Record<string, Json>;
  queue?: Json;
  mode?: Json;
  modeNotedTs?: number;
  [key: string]: Json;
}

export function readState(file: string): PeerState {
  const s = readJson<Record<string, Json>>(file);
  if (s && typeof s === "object") {
    return {
      lastPollAt: Number(s.lastPollAt) || 0,
      topics: s.topics && typeof s.topics === "object" ? s.topics : {},
      seen: Array.isArray(s.seen) ? s.seen.filter((x: unknown) => typeof x === "string") : [],
      reserved: s.reserved && typeof s.reserved === "object" ? Object.fromEntries(Object.entries(s.reserved).filter(([, v]: [string, Json]) => Number.isFinite(v) || Number.isFinite(v?.until))) : {},
      ...(s.queue && typeof s.queue === "object" ? { queue: s.queue } : {}),
      ...(s.mode && typeof s.mode === "object" ? { mode: s.mode } : {}),
      ...(Number.isFinite(s.modeNotedTs) ? { modeNotedTs: s.modeNotedTs } : {}),
    };
  }
  return { lastPollAt: 0, topics: {}, seen: [], reserved: {} };
}

export function writeState(file: string, state: unknown): void {
  writeJson(file, state);
}
