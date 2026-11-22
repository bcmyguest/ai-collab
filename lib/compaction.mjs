/** One compaction model for every harness: phase, trigger and token counts on the compact activity row. */
export const COMPACTION_PHASES = ["started", "finished", "failed"];
export const COMPACTION_TRIGGERS = ["auto", "manual"];

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
