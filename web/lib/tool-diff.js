// Tool inputs as file diffs: Claude Edit, MultiEdit and Write, and Codex apply_patch.
const EDIT_TOOL = /^(edit|multiedit)$/i;
const WRITE_TOOL = /^write$/i;
const PATCH_TOOL = /^apply_patch$/i;
const CONTEXT = 3;
const CLIP = /…\[truncated \d+ bytes\]$/;
const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const WRITTEN = /\bupdated\b|overwr/i;
export const DIFF_MAX_LINES = 400;

// Lines of a text: "" has none, one trailing newline adds none.
const linesOf = text => typeof text === "string" && text !== "" ? text.replace(/\n$/, "").split("\n") : [];
const lineOf = (t, s) => ({ t, s });
const countOf = (lines, t) => lines.filter(line => line.t === t).length;

// The hunk for one replacement: changed lines with up to CONTEXT unchanged lines around them.
function replaceHunk(oldText, newText) {
  const a = linesOf(oldText);
  const b = linesOf(newText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const before = a.slice(Math.max(0, head - CONTEXT), head).map(s => lineOf(" ", s));
  const after = a.slice(a.length - Math.min(CONTEXT, tail)).map(s => lineOf(" ", s));
  const removed = a.slice(head, a.length - tail).map(s => lineOf("-", s));
  const added = b.slice(head, b.length - tail).map(s => lineOf("+", s));
  return { lines: [...before, ...removed, ...added, ...after] };
}

const withHunks = (path, kind, hunks, notes = []) => {
  const kept = hunks.filter(hunk => hunk.lines.some(line => line.t !== " "));
  const lines = kept.flatMap(hunk => hunk.lines);
  return { path, kind, hunks: kept, added: countOf(lines, "+"), removed: countOf(lines, "-"), notes };
};

// A complete JSON string value of a key in text, or undefined.
function stringField(text, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
  return match ? JSON.parse(`"${match[1]}"`) : undefined;
}

// The start of a string value of a key that the clip cut short, decoded up to the cut.
function partialString(text, key) {
  const start = new RegExp(`"${key}"\\s*:\\s*"`).exec(text);
  if (!start) return undefined;
  let body = text.slice(start.index + start[0].length).replace(/\\u[0-9a-fA-F]{0,3}$/, "");
  const trailing = /\\*$/.exec(body)[0].length;
  if (trailing % 2) body = body.slice(0, -1);
  return JSON.parse(`"${body}"`);
}

// Claude's Edit, MultiEdit and Write inputs: old and new text, or the full content of a new file.
function claudeFiles(tool, value, output) {
  const path = value.file_path ?? value.filePath;
  if (typeof path !== "string" || !path) return null;
  if (WRITE_TOOL.test(tool)) {
    if (typeof value.content !== "string") return null;
    return [{ ...withHunks(path, "add", [{ lines: linesOf(value.content).map(s => lineOf("+", s)) }]), written: WRITTEN.test(output || "") }];
  }
  const edits = /^multiedit$/i.test(tool) ? value.edits : [value];
  if (!Array.isArray(edits) || !edits.length) return null;
  if (!edits.every(edit => typeof edit?.old_string === "string" && typeof edit?.new_string === "string")) return null;
  const notes = [];
  if (edits.some(edit => edit.replace_all === true)) notes.push("replace all occurrences");
  const hunks = edits.map(edit => replaceHunk(edit.old_string, edit.new_string));
  if (!hunks.some(hunk => hunk.lines.some(line => line.t !== " ")) && edits.some(edit => edit.old_string !== edit.new_string)) notes.push("whitespace or trailing newline only");
  return [withHunks(path, "update", hunks, notes)];
}

// Codex apply_patch envelope: "*** Begin Patch" with Add, Update and Delete File sections.
function envelopeFiles(lines) {
  const files = [];
  let file = null;
  let hunk = null;
  for (const line of lines) {
    const section = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (section) {
      file = { path: section[2].trim(), kind: { add: "add", update: "update", delete: "delete" }[section[1].toLowerCase()], hunks: [] };
      files.push(file);
      hunk = null;
    } else if (/^\*\*\* Move to: /.test(line) && file) {
      file.path = line.slice("*** Move to: ".length).trim();
    } else if (/^\*\*\* End Patch/.test(line)) {
      file = null;
      hunk = null;
    } else if (/^\*\*\* End of File/.test(line)) {
      hunk = null;
    } else if (!file || line.startsWith("*** ")) {
      continue;
    } else if (line.startsWith("@@")) {
      hunk = { lines: [] };
      file.hunks.push(hunk);
    } else if (/^[ +-]/.test(line) || line === "") {
      // A blank line outside a hunk is the newline before the next section, not context.
      if (line === "" && !hunk) continue;
      if (!hunk) {
        hunk = { lines: [] };
        file.hunks.push(hunk);
      }
      hunk.lines.push(lineOf(line === "" ? " " : line[0], line.slice(1)));
    }
  }
  return files.map(item => withHunks(item.path, item.kind, item.hunks));
}

// Unified diff text (git or plain ---/+++ headers): one entry per file. A hunk's header counts say how many lines it holds, so a removed "-- x" line is a hunk line, not a header.
function unifiedFiles(lines) {
  const files = [];
  let file = null;
  let hunk = null;
  let left = { old: 0, next: 0 };
  for (const line of lines) {
    const open = hunk && (left.old > 0 || left.next > 0);
    if (open && (line === "" || /^[ +-]/.test(line))) {
      const t = line === "" ? " " : line[0];
      hunk.lines.push(lineOf(t, line.slice(1)));
      if (t !== "+") left.old -= 1;
      if (t !== "-") left.next -= 1;
    } else if (line.startsWith("diff --git ")) {
      file = { path: line.split(" b/").pop(), kind: "update", hunks: [] };
      files.push(file);
      hunk = null;
    } else if (line.startsWith("--- ")) {
      // A git header already opened this file; a plain header opens the next one.
      if (!file || file.hunks.length) {
        file = { path: "", kind: "update", hunks: [] };
        files.push(file);
        hunk = null;
      }
      if (line.startsWith("--- /dev/null")) file.kind = "add";
      else file.path ||= line.slice(4).trim().replace(/^a\//, "");
    } else if (line.startsWith("+++ ") && file) {
      if (line.startsWith("+++ /dev/null")) file.kind = "delete";
      else file.path = line.slice(4).trim().replace(/^b\//, "");
    } else if (HUNK.test(line) && file) {
      const [, old, next] = HUNK.exec(line);
      hunk = { lines: [] };
      file.hunks.push(hunk);
      left = { old: old === undefined ? 1 : Number(old), next: next === undefined ? 1 : Number(next) };
    }
  }
  return files.filter(item => item.path).map(item => withHunks(item.path, item.kind, item.hunks));
}

// The patch text of an apply_patch input: a bare string, or the command, input or patch field of an object.
function patchTextOf(input) {
  let value;
  try { value = JSON.parse(input); } catch { return input; }
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const text = [value.input, value.command, value.patch].find(item => typeof item === "string" || Array.isArray(item));
  return Array.isArray(text) ? text.findLast(item => typeof item === "string") ?? null : text ?? null;
}

// The patch text of a clipped apply_patch input: the decoded part of its string field, or the raw text.
function clippedPatchTextOf(body) {
  if (!body.trimStart().startsWith("{")) return body;
  for (const key of ["input", "command", "patch"]) {
    const text = partialString(body, key);
    if (text !== undefined) return text;
  }
  return null;
}

// Parses a Codex or unified patch into files; null when the text is neither.
function patchFiles(text) {
  if (typeof text !== "string") return null;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.includes("*** Begin Patch")) return envelopeFiles(lines);
  if (lines.some(line => line.startsWith("+++ ")) && lines.some(line => line.startsWith("@@"))) return unifiedFiles(lines);
  return null;
}

// The fields a clipped Edit input still holds whole; a Write or MultiEdit clipped short is not shown.
function clippedClaudeValue(tool, body) {
  if (!EDIT_TOOL.test(tool) || /^multiedit$/i.test(tool)) return null;
  const path = stringField(body, "file_path") ?? stringField(body, "filePath");
  const oldText = stringField(body, "old_string");
  const newText = stringField(body, "new_string");
  if (path === undefined || oldText === undefined || newText === undefined) return null;
  return { file_path: path, old_string: oldText, new_string: newText, replace_all: /"replace_all"\s*:\s*true/.test(body) };
}

/**
 * Files a tool input changes as diffs, or null when the input is not a file edit:
 * { files: [{ path, kind, hunks, added, removed, notes, written }], truncated }.
 * output is the tool result text; a Write whose result says "updated" overwrote the file.
 */
export function toolDiff(tool, input, output = "") {
  if (!input || typeof tool !== "string") return null;
  const truncated = CLIP.test(input);
  const body = truncated ? input.replace(CLIP, "") : input;
  if (PATCH_TOOL.test(tool)) {
    const files = patchFiles(truncated ? clippedPatchTextOf(body) : patchTextOf(input));
    return files?.length ? { files, truncated } : null;
  }
  if (!EDIT_TOOL.test(tool) && !WRITE_TOOL.test(tool)) return null;
  let value;
  if (truncated) value = clippedClaudeValue(tool, body);
  else {
    try { value = JSON.parse(input); } catch { return null; }
  }
  const files = value && typeof value === "object" ? claudeFiles(tool, value, output) : null;
  return files ? { files, truncated } : null;
}

/** A unified diff for one file: headers, then each hunk with counts recomputed from its lines (line numbers are not known). */
export function patchOf(file) {
  const name = file.path.replace(/^\/+/, "");
  const out = [`--- ${file.kind === "add" ? "/dev/null" : "a/" + name}`, `+++ ${file.kind === "delete" ? "/dev/null" : "b/" + name}`];
  for (const hunk of file.hunks) {
    const old = countOf(hunk.lines, " ") + countOf(hunk.lines, "-");
    const next = countOf(hunk.lines, " ") + countOf(hunk.lines, "+");
    out.push(`@@ -${old ? 1 : 0},${old} +${next ? 1 : 0},${next} @@`);
    for (const line of hunk.lines) out.push(line.t + line.s);
  }
  return out.join("\n");
}

/** The files with at most max diff lines across them, and the count of lines left out. */
export function limitFiles(files, max = DIFF_MAX_LINES) {
  const total = files.reduce((sum, file) => sum + file.hunks.reduce((n, hunk) => n + hunk.lines.length, 0), 0);
  let budget = max;
  const shown = files.map(file => {
    const hunks = [];
    for (const hunk of file.hunks) {
      if (budget <= 0) break;
      const lines = hunk.lines.slice(0, budget);
      budget -= lines.length;
      hunks.push({ lines });
    }
    return { ...file, hunks };
  });
  const kept = shown.reduce((sum, file) => sum + file.hunks.reduce((n, hunk) => n + hunk.lines.length, 0), 0);
  return { files: shown, hidden: total - kept };
}
