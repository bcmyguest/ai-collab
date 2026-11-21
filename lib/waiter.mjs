/**
 * Claude asyncRewake waiter: streams this session's inbox and broadcast topics (stop.mjs streamWaiter) while the
 * session is idle. When a non-fyi message arrives it claims the inbox and returns it; the hook script then exits 2,
 * which wakes the idle session. One waiter per session: a pid file in the session state dir; a new waiter kills the old one.
 */
import { readFileSync, rmSync } from "node:fs";
import { claimInbox } from "./inbox.mjs";
import { formatInbox, identityLine } from "./format.mjs";
import { isRunning, processStart } from "./process.mjs";
import { sendReceipts, settleReceipts } from "./receipts.mjs";
import { streamWaiter } from "./stop.mjs";
import { statePath, withLock, writeState } from "./state.mjs";

// Below the 3600 s hook timeout in hooks/hooks.json; the next hook event re-arms a waiter that ran out.
export const WAITER_MAX_S = 3300;
const SLICE_MS = 30_000;

function slotFile(cfg) {
  return statePath(cfg).replace(/\.json$/, ".waiter.json");
}

function readSlot(file) {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    return Number.isInteger(s.pid) && typeof s.start === "string" ? s : null;
  } catch {
    return null;
  }
}

/** Takes the session's single waiter slot: stops the previous waiter, records this process. Returns the release function. */
export async function takeWaiterSlot(cfg, { pid = process.pid, kill = process.kill.bind(process) } = {}) {
  const file = slotFile(cfg);
  await withLock(file, () => {
    const old = readSlot(file);
    if (old && old.pid !== pid && isRunning({ pid: old.pid, start: old.start })) {
      try { kill(old.pid, "SIGTERM"); } catch { /* already gone */ }
    }
    writeState(file, { pid, start: processStart(pid) || "" });
  });
  return () => {
    if (readSlot(file)?.pid === pid) rmSync(file, { force: true });
  };
}

function wakeText(cfg, messages) {
  return [
    identityLine(cfg),
    formatInbox(messages, { session: cfg.session }),
    "[ai-collab] These messages arrived while this session was idle. Answer the operator as instructed above.",
  ].filter(Boolean).join("\n");
}

/**
 * Waits for a wake-worthy message until maxMs. Resolves {code: 2, text} with claimed messages, or {code: 0}
 * on timeout, abort or when alive() turns false. A message with priority fyi never wakes the session.
 */
export async function runWaiter(cfg, {
  maxMs = WAITER_MAX_S * 1000, wait, claim = claimInbox, alive = () => true, now = Date.now, signal,
} = {}) {
  const end = now() + maxMs;
  const waitFor = wait ?? streamWaiter(cfg, now());
  for (;;) {
    const waiting = (await claim(cfg, { commit: false }).catch(() => [])).some((m) => m.priority !== "fyi");
    if (waiting) {
      const messages = await claim(cfg, { limit: 4 }).catch(() => []);
      if (messages.length) {
        sendReceipts(cfg, messages.map((m) => m.id));
        await settleReceipts();
        return { code: 2, text: wakeText(cfg, messages) };
      }
    }
    const left = end - now();
    if (left <= 0 || signal?.aborted || !alive()) return { code: 0 };
    if ((await waitFor(Math.min(left, SLICE_MS), signal)) === "aborted") return { code: 0 };
  }
}
