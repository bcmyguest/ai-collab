/** One compaction model for every harness: phase, trigger and token counts on the compact activity row. */
export const COMPACTION_PHASES = ["started", "finished", "failed"];
export const COMPACTION_TRIGGERS = ["auto", "manual"];
export const COMPACTION_HISTORY_MAX = 20;

const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : undefined);

/** {trigger?, phase, tokensBefore?, tokensAfter?, filesDropped?}, or null for an unknown phase; a trigger or count the harness omits stays absent. */
export function compactionFields({ trigger, phase, tokensBefore, tokensAfter, filesDropped } = {}) {
  if (!COMPACTION_PHASES.includes(phase)) return null;
  const fields = {};
  if (COMPACTION_TRIGGERS.includes(trigger)) fields.trigger = trigger;
  fields.phase = phase;
  if (count(tokensBefore) !== undefined) fields.tokensBefore = tokensBefore;
  if (count(tokensAfter) !== undefined) fields.tokensAfter = tokensAfter;
  if (count(filesDropped) !== undefined) fields.filesDropped = filesDropped;
  return fields;
}

/** Per agent, its last {max} compactions as {at (ms), ...fields}, oldest first, from activity items with a compaction. */
export function compactionHistory(items, max = COMPACTION_HISTORY_MAX) {
  const byAgent = new Map();
  for (const item of items) {
    if (item.type !== "compact" || !item.compaction) continue;
    const fields = compactionFields(item.compaction);
    if (!fields) continue;
    const list = byAgent.get(item.agent) || [];
    list.push({ at: item.time * 1000, ...fields });
    byAgent.set(item.agent, list.slice(-max));
  }
  return byAgent;
}
