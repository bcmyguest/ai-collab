// Context meter and "files read" for a session. Pure: used by the session header and tested in test/context-view.test.mjs.

const WARN_PERCENT = 80;
const FULL_PERCENT = 95;
const READ_TOOLS = /^(read|read_file)$/i;
const PATH_FIELDS = ["file_path", "filePath", "path"];

/** "842", "9.5k", "258k", "1.2M": one decimal under 10k and 10M, whole numbers above. */
export function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "") + "k";
  return String(n);
}

/**
 * {text, percent, level} for {tokens, window}. percent and the level are set only when the harness reported a window;
 * level is "ok", "warn" (80% or more) or "full" (95% or more).
 */
export function contextMeter({ tokens, window } = {}) {
  if (!Number.isSafeInteger(tokens)) return { text: "", percent: null, level: "unknown" };
  if (!Number.isSafeInteger(window) || window <= 0) return { text: formatTokens(tokens) + " tokens", percent: null, level: "unknown" };
  const percent = Math.min(100, Math.round((tokens / window) * 100));
  const level = percent >= FULL_PERCENT ? "full" : percent >= WARN_PERCENT ? "warn" : "ok";
  return { text: `${formatTokens(tokens)} of ${formatTokens(window)} · ${percent}%`, percent, level };
}

function pathOf(input) {
  let value = input;
  if (typeof input === "string") {
    try { value = JSON.parse(input); } catch { return ""; }
  }
  if (!value || typeof value !== "object") return "";
  const found = PATH_FIELDS.map(field => value[field]).find(path => typeof path === "string" && path.trim());
  return found ? found.trim() : "";
}

/** Files the session read, from its tool-call rows: [{path, count}], most recently read first. */
export function filesRead(rows = []) {
  const seen = new Map();
  for (const row of rows) {
    if (row?.type !== "tool_call" || !READ_TOOLS.test(row.tool || "")) continue;
    const path = pathOf(row.input);
    if (!path) continue;
    const entry = seen.get(path) || { path, count: 0 };
    entry.count += 1;
    seen.delete(path);
    seen.set(path, entry);
  }
  return [...seen.values()].reverse();
}
