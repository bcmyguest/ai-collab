/** Clear and model switch in one model, beside compaction (lib/compaction.ts); both ride the activity row's own field. */
import { COMPACTION_HISTORY_MAX, compactionFields } from "./compaction.ts";

// oxlint-disable-next-line typescript/no-explicit-any -- activity rows are bus JSON validated field by field
type Json = any;
export type ClearFields = { tokensBefore?: number; tokensAfter: 0 };
export type ModelFields = { from: string; to: string };

const count = (value: unknown): number | undefined => (Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined);
const MODEL_MAX = 128;
const model = (value: unknown): string | undefined => (typeof value === "string" && value.trim() && value.length <= MODEL_MAX ? value.trim() : undefined);

/** {tokensBefore?, tokensAfter: 0}: a clear empties the context, so the after count is 0 by definition. */
export function clearFields({ tokensBefore }: { tokensBefore?: unknown } = {}): ClearFields {
  const before = count(tokensBefore);
  return { ...(before === undefined ? {} : { tokensBefore: before }), tokensAfter: 0 };
}

/** {from, to} model names, or null when either is missing. */
export function modelFields({ from, to }: { from?: unknown; to?: unknown } = {}): ModelFields | null {
  const [a, b] = [model(from), model(to)];
  return a && b ? { from: a, to: b } : null;
}

// The run a row belongs to: its agent, and its subagent run when it has one.
const runOf = (row: Json): string => `${row.agent || ""}|${row.subagent?.id || ""}`;
const fill = (finished: Json, started: Json): Json => {
  const out = { ...finished };
  if (out.tokensBefore === undefined && started.tokensBefore !== undefined) out.tokensBefore = started.tokensBefore;
  if (out.filesDropped === undefined && started.filesDropped !== undefined) out.filesDropped = started.filesDropped;
  return out;
};

/** Each finished or failed compaction takes the fields of the started one before it in its run; that started row is dropped.
 *  Rows without a compaction (clears, model switches, texts) do not break a pair. */
export function pairCompactions(rows: Json[]): Json[] {
  const open = new Map<string, number>();
  const consumed = new Set<number>();
  const fixed = new Map<number, Json>();
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
export function sessionHistory(items: Json[], max: number = COMPACTION_HISTORY_MAX): Map<string, Json[]> {
  const perAgent = new Map<string, Json[]>();
  for (const item of items) {
    const row = rowOf(item);
    if (!row) continue;
    const list = perAgent.get(item.agent) || [];
    list.push(row);
    perAgent.set(item.agent, list);
  }
  const byAgent = new Map<string, Json[]>();
  for (const [agent, rows] of perAgent) {
    const entries = pairCompactions(rows).map(entryOf);
    byAgent.set(agent, entries.slice(-max));
  }
  return byAgent;
}

// An activity item as a row with its fields validated; null for items that are not session events.
function rowOf(item: Json): Json {
  // A subagent's compaction belongs to its run, not the parent's history.
  if (item.subagent) return null;
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
function entryOf(row: Json): Json {
  const at = row.time * 1000;
  if (row.type === "compact") return { id: row.id, at, kind: "compaction", ...row.compaction };
  if (row.type === "clear") return { id: row.id, at, kind: "clear", ...row.clear };
  return { id: row.id, at, kind: "model", ...row.modelSwitch };
}
