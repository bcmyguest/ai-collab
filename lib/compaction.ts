/** One compaction model for every harness: phase, trigger and token counts on the compact activity row. */
export const COMPACTION_PHASES: unknown[] = ["started", "finished", "failed"];
export const COMPACTION_TRIGGERS: unknown[] = ["auto", "manual"];
export const COMPACTION_HISTORY_MAX = 20;

const count = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 ? value : undefined);

export type CompactionFields = { trigger?: string; phase: string; tokensBefore?: number; tokensAfter?: number; filesDropped?: number };

/** {trigger?, phase, tokensBefore?, tokensAfter?, filesDropped?}, or null for an unknown phase; a trigger or count the harness omits stays absent. */
export function compactionFields({ trigger, phase, tokensBefore, tokensAfter, filesDropped }: { trigger?: unknown; phase?: unknown; tokensBefore?: unknown; tokensAfter?: unknown; filesDropped?: unknown } = {}): CompactionFields | null {
  if (!COMPACTION_PHASES.includes(phase)) return null;
  const fields = {} as CompactionFields;
  if (COMPACTION_TRIGGERS.includes(trigger)) fields.trigger = trigger as string;
  fields.phase = phase as string;
  if (count(tokensBefore) !== undefined) fields.tokensBefore = tokensBefore as number;
  if (count(tokensAfter) !== undefined) fields.tokensAfter = tokensAfter as number;
  if (count(filesDropped) !== undefined) fields.filesDropped = filesDropped as number;
  return fields;
}
