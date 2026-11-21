/** 3 for a prefix, 2 for a word start, 1 for a subsequence, 0 for no match; whitespace in the query is ignored. */
export function fuzzyScore(query, text) {
  const q = String(query).toLowerCase().replace(/\s+/g, "");
  const t = String(text || "").toLowerCase();
  if (!q) return 1;
  if (!t) return 0;
  if (t.startsWith(q)) return 3;
  if (new RegExp("[^a-z0-9]" + q.replace(/[^a-z0-9]/g, "\\$&")).test(t)) return 2;
  let at = 0;
  for (const char of t) if (char === q[at]) at++;
  return at === q.length ? 1 : 0;
}

/** The best-scoring options for query (ties keep their order), scored by the best of fields(option). */
export function fuzzyRank(query, options, fields, limit = 8) {
  return options.map((option, i) => ({ option, i, score: Math.max(0, ...fields(option).map(text => fuzzyScore(query, text))) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map(item => item.option);
}
