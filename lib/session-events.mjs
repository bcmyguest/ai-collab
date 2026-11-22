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

/** Per agent, its last {max} session events as {at (ms), kind, ...fields}, oldest first. kind: compaction, clear or model. */
export function sessionHistory(items, max = COMPACTION_HISTORY_MAX) {
  const byAgent = new Map();
  for (const item of items) {
    const entry = item.type === "compact" && item.compaction ? kindOf("compaction", compactionFields(item.compaction))
      : item.type === "clear" && item.clear ? kindOf("clear", clearFields(item.clear))
        : item.type === "model" && item.modelSwitch ? kindOf("model", modelFields(item.modelSwitch))
          : null;
    if (!entry) continue;
    const list = byAgent.get(item.agent) || [];
    list.push({ at: item.time * 1000, ...entry });
    byAgent.set(item.agent, list.slice(-max));
  }
  return byAgent;
}

const kindOf = (kind, fields) => (fields ? { kind, ...fields } : null);
