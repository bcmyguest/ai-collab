// Compaction rows as timeline text: "Compacted · auto · 182k → 31k · 4 files dropped".
const WORDS = { started: "Compacting", finished: "Compacted", failed: "Compaction failed" };

/** Tokens as "182k" from 1000 up; smaller counts stay exact. */
export function tokenCount(tokens) {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/** The timeline text of one compaction, or "" when its phase is unknown. */
export function compactionText(compaction) {
  if (!WORDS[compaction?.phase]) return "";
  const { trigger, tokensBefore, tokensAfter, filesDropped } = compaction;
  const sizes = tokensBefore === undefined ? ""
    : tokensAfter === undefined ? tokenCount(tokensBefore) : `${tokenCount(tokensBefore)} → ${tokenCount(tokensAfter)}`;
  const files = filesDropped > 0 ? `${filesDropped} ${filesDropped === 1 ? "file" : "files"} dropped` : "";
  return [WORDS[compaction.phase], trigger, sizes, files].filter(Boolean).join(" · ");
}

const isCompact = row => row?.type === "compact" && row.compaction;

/** Each finished compaction takes its tokensBefore and filesDropped from the started row before it. */
export function pairCompactions(rows) {
  let open = null;
  return rows.map(row => {
    if (!isCompact(row)) return row;
    const { compaction } = row;
    if (compaction.phase === "started") { open = compaction; return row; }
    if (!open || compaction.phase !== "finished") { open = null; return row; }
    const merged = { ...compaction };
    if (merged.tokensBefore === undefined && open.tokensBefore !== undefined) merged.tokensBefore = open.tokensBefore;
    if (merged.filesDropped === undefined && open.filesDropped !== undefined) merged.filesDropped = open.filesDropped;
    open = null;
    return { ...row, compaction: merged };
  });
}

/** Tokens left under the window, or null unless the harness reported both counts; the auto-compact point is never guessed. */
export function headroom({ tokens, window } = {}) {
  if (!Number.isSafeInteger(tokens) || !Number.isSafeInteger(window) || window <= 0) return null;
  return { left: Math.max(0, window - tokens), window };
}

/** Where a time sits on the map axis from start to end, as a percent; 0 when the axis has no width. */
export function axisPercent(at, start, end) {
  return end > start ? Math.min(100, Math.max(0, ((at - start) / (end - start)) * 100)) : 0;
}

/** The map axis: from the oldest compaction (or an hour before now) to now. */
export function mapAxis(histories, now) {
  const times = histories.flat().map(item => item.at);
  return { start: Math.min(now - 60 * 60_000, ...times), end: now };
}

/** "Cleared · 140k → 0", or "Cleared" when the count before is unknown. */
export function clearText({ tokensBefore, tokensAfter } = {}) {
  return tokensBefore === undefined ? "Cleared" : `Cleared · ${tokenCount(tokensBefore)} → ${tokenCount(tokensAfter ?? 0)}`;
}

/** "Model claude-haiku-5-5 → claude-opus-5-5". */
export function modelText({ from, to }) {
  return `Model ${from} → ${to}`;
}
