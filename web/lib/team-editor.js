// Team editor text: a team's name is its digraph name, and a parse error names a line of the text.
const DIGRAPH_NAME = /^(\s*digraph\s+)("(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_]*)/m;

/** The text with its digraph named name; text without a digraph line comes back unchanged. */
export function renameTeam(text, name) {
  return name ? text.replace(DIGRAPH_NAME, (_, head) => `${head}"${name}"`) : text;
}

/** The source line a parse error names (1-based), or "" when the error names no line. */
export function sourceLine(text, line) {
  return line ? text.split("\n")[line - 1] ?? "" : "";
}
