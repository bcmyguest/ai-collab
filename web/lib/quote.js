// Quote text for a reply: the replied message's first line of words, clipped to QUOTE_CHARS.
export const QUOTE_CHARS = 80;

/** The body on one line, at most QUOTE_CHARS characters, ending in an ellipsis when clipped. */
export function quoteText(body) {
  const line = String(body || "").replace(/\s+/g, " ").trim();
  return line.length > QUOTE_CHARS ? line.slice(0, QUOTE_CHARS - 1).trimEnd() + "…" : line;
}
