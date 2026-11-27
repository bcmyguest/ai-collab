import { alertPriority, readAlertLevel } from "./alerts.ts";
/**
 * Read receipts: when a hook, MCP tool or CLI command hands messages to an agent, it publishes
 * The ai-collab.receipt event carries the reader and read message IDs to ai-collab-<project>--receipts.
 * Best effort: publishes run in the background, never throw, and are capped at RECEIPT_TIMEOUT_MS.
 */
import { MESSAGE_MAX_BYTES, SESSION_LABEL, isValidName, receiptsTopic } from "./config.mjs";
import { publish } from "./messaging.ts";
import { encodeEnvelope, parseWireEnvelope } from "./agui.mjs";

export const RECEIPT_TIMEOUT_MS = 1500;
const MESSAGE_ID = /^[a-zA-Z0-9-]{1,64}$/;
const READS_MAX = 5000;
const pending = new Set();

function receipt(cfg, ids, ts) {
  return encodeEnvelope("receipt", { from: cfg.peer, ...(cfg.session ? { session: cfg.session } : {}), ids, state: "read", ts }, cfg.wire);
}

// Receipt envelopes for ids, split so each stays within ntfy's message limit.
export function receiptMessages(cfg, ids, ts = new Date().toISOString()) {
  const batches = [];
  for (const id of ids) {
    const last = batches.at(-1);
    if (last && Buffer.byteLength(receipt(cfg, [...last, id], ts)) <= MESSAGE_MAX_BYTES) last.push(id);
    else batches.push([id]);
  }
  return batches.map((batch) => receipt(cfg, batch, ts));
}

/** Starts a background read-receipt publish for delivered message ids; await settleReceipts() before exiting. */
export function sendReceipts(cfg, ids) {
  const valid = [...new Set(ids)].filter((id) => typeof id === "string" && MESSAGE_ID.test(id));
  if (!cfg?.enabled || !valid.length) return;
  const signal = AbortSignal.timeout(RECEIPT_TIMEOUT_MS);
  const task = Promise.all(receiptMessages(cfg, valid).map((message) =>
    publish(cfg, receiptsTopic(cfg.project), message, { title: "ai-collab receipt", signal, priority: alertPriority(readAlertLevel(), "other") }))).catch(() => {});
  pending.add(task);
  task.finally(() => pending.delete(task));
}

/** Resolves when every receipt publish started by this process has finished or timed out. */
export const settleReceipts = () => Promise.all(pending);

/** Adds each receipt's reader (peer#session) to reads: message id → Set of readers. Oldest ids drop past READS_MAX. */
export function readReceipts(events, reads = new Map(), limit = READS_MAX) {
  for (const ev of events) {
    const m = parseWireEnvelope(ev.message);
    if (m?.kind !== "receipt" || m.state !== "read" || !isValidName(m.from) || !Array.isArray(m.ids)) continue;
    const reader = typeof m.session === "string" && SESSION_LABEL.test(m.session) ? `${m.from}#${m.session}` : m.from;
    for (const id of m.ids) {
      if (typeof id !== "string" || !MESSAGE_ID.test(id)) continue;
      if (!reads.has(id)) reads.set(id, new Set());
      reads.get(id).add(reader);
    }
  }
  for (const id of reads.keys()) {
    if (reads.size <= limit) break;
    reads.delete(id);
  }
  return reads;
}
