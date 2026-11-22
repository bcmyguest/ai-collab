/** Clear and model switch in one model, beside compaction (lib/compaction.mjs); both ride the activity row's own field. */
import { COMPACTION_HISTORY_MAX, compactionFields } from "./compaction.mjs";

const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : undefined);
const MODEL_MAX = 128;
const model = value => (typeof value === "string" && value.trim() && value.length <= MODEL_MAX ? value.trim() : undefined);

/** {tokensBefore?, tokensAfter: 0}: a clear empties the context, so the after count is 0 by definition. */
export function clearFields({ tokensBefore } = {}) {
  const before = count(tokensBefore);
  return { ...(before === undefined ? {} : { tokensBefore: before }), tokensAfter: 0 };
}

/** {from, to} model names, or null when either is missing. */
export function modelFields({ from, to } = {}) {
  const [a, b] = [model(from), model(to)];
  return a && b ? { from: a, to: b } : null;
}

// The run a row belongs to: its agent, and its subagent run when it has one.
const runOf = row => `${row.agent || ""}|${row.subagent?.id || ""}`;
const fill = (finished, started) => {
  const out = { ...finished };
  if (out.tokensBefore === undefined && started.tokensBefore !== undefined) out.tokensBefore = started.tokensBefore;
  if (out.filesDropped === undefined && started.filesDropped !== undefined) out.filesDropped = started.filesDropped;
  return out;
};

/** Each finished or failed compaction takes the fields of the started one before it in its run; that started row is dropped.
 *  Rows without a compaction (clears, model switches, texts) do not break a pair. */
export function pairCompactions(rows) {
  const open = new Map();
  const consumed = new Set();
  const fixed = new Map();
  rows.forEach((row, i) => {
    const compaction = row.compaction;
    if (!compaction) return;
    const run = runOf(row);
    if (compaction.phase === "started") { open.set(run, i); return; }
    const at = open.get(run);
    if (at === undefined) return;
    open.delete(run);
    consumed.add(at);
    fixed.set(i, { ...row, compaction: fill(compaction, rows[at].compaction) });
  });
  return rows.flatMap((row, i) => (consumed.has(i) ? [] : [fixed.get(i) ?? row]));
}

/** Per agent, its last {max} session events as {at (ms), kind, ...fields}, oldest first. kind: compaction, clear or model. */
export function sessionHistory(items, max = COMPACTION_HISTORY_MAX) {
  const perAgent = new Map();
  for (const item of items) {
    const row = rowOf(item);
    if (!row) continue;
    const list = perAgent.get(item.agent) || [];
    list.push(row);
    perAgent.set(item.agent, list);
  }
  const byAgent = new Map();
  for (const [agent, rows] of perAgent) {
    const entries = pairCompactions(rows).map(entryOf);
    byAgent.set(agent, entries.slice(-max));
  }
  return byAgent;
}

// An activity item as a row with its fields validated; null for items that are not session events.
function rowOf(item) {
  const base = { id: item.id, time: item.time, agent: item.agent };
  if (item.type === "compact" && item.compaction) {
    const compaction = compactionFields(item.compaction);
    return compaction ? { ...base, type: "compact", compaction } : null;
  }
  if (item.type === "clear" && item.clear) return { ...base, type: "clear", clear: clearFields(item.clear) };
  if (item.type === "model" && item.modelSwitch) {
    const modelSwitch = modelFields(item.modelSwitch);
    return modelSwitch ? { ...base, type: "model", modelSwitch } : null;
  }
  return null;
}

// A history entry: {id, at (ms), kind, ...fields}.
function entryOf(row) {
  const at = row.time * 1000;
  if (row.type === "compact") return { id: row.id, at, kind: "compaction", ...row.compaction };
  if (row.type === "clear") return { id: row.id, at, kind: "clear", ...row.clear };
  return { id: row.id, at, kind: "model", ...row.modelSwitch };
}
