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
